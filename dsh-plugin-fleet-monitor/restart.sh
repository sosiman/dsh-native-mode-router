#!/usr/bin/env bash
# Reinicia `dsh web` respetando el supervisor de motores.
#
# El proceso de dsh web de este equipo lo lanza mode-router-real/supervisor.mjs con
# `--patch ~/.dsh/modes/<modo>.yml`. Por eso NO hay que usar restart-dsh-web.sh:
# arrancaria un segundo proceso peleando por el puerto 3080.
#
#   bash restart.sh --dry-run     # ensena que haria (no toca nada)
#   bash restart.sh               # reinicia ahora (corta la sesion abierta)
#
# Tras reiniciar, el token de la web cambia: la URL nueva queda en
# ~/.dsh/mode-router/last-url.txt y se imprime por pantalla.
set -euo pipefail

DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY=1 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "opcion desconocida: $arg" >&2; exit 2 ;;
  esac
done

HOME_DIR="${HOME:-/root}"
DSH_HOME_DIR="$HOME_DIR/.dsh"
STATE_FILE="$DSH_HOME_DIR/mode-router/state.json"
LOG_FILE="$DSH_HOME_DIR/mode-router/nohup.log"
URL_FILE="$DSH_HOME_DIR/mode-router/last-url.txt"
SUPERVISOR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/mode-router-real/supervisor.mjs"
NODE_BIN="${NODE_BIN:-$(which node 2>/dev/null || echo "node")}"
DSH_BIN="${DSH_BIN:-$(which dsh 2>/dev/null || echo "dsh")}"
UNIT="dsh-mode-router"

say() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY" = "1" ]; then say "[dry-run] $*"; else "$@"; fi
}

mode=standard
if [ -f "$STATE_FILE" ]; then
  mode="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("mode","standard"))' "$STATE_FILE" 2>/dev/null || echo standard)"
fi
say "modo actual: $mode"

sup_pid="$(pgrep -f "supervisor.mjs" | head -1 || true)"
dsh_pid="$(pgrep -f "dsh web --patch" | head -1 || true)"
say "supervisor pid: ${sup_pid:-ninguno}"
say "dsh web pid:    ${dsh_pid:-ninguno}"

if [ -n "$sup_pid" ]; then
  say "plan: parar supervisor (arrastra a dsh web) y relanzarlo bajo systemd de usuario"
  run systemctl --user stop "$UNIT" 2>/dev/null || true
  run kill -TERM "$sup_pid" || true
  run sleep 2
  if [ "$DRY" = "1" ]; then
    say "[dry-run] systemd-run --user --collect --unit=$UNIT ... $NODE_BIN $SUPERVISOR --mode $mode"
  else
    systemd-run --user --collect --unit="$UNIT" \
      --property=StandardOutput=append:"$LOG_FILE" \
      --property=StandardError=append:"$LOG_FILE" \
      --property=WorkingDirectory="$HOME_DIR" \
      --setenv=HOME="$HOME_DIR" --setenv=DSH_HOME="$DSH_HOME_DIR" \
      --setenv=DSH_BIN="$DSH_BIN" \
      "$NODE_BIN" "$SUPERVISOR" --mode "$mode" >/dev/null
    say "supervisor relanzado como unidad de usuario: $UNIT"
  fi
elif [ -n "$dsh_pid" ]; then
  say "no hay supervisor; reinicio dsh web directo con el patch del modo actual"
  run kill -TERM "$dsh_pid" || true
  run sleep 1
  if [ "$DRY" = "1" ]; then
    say "[dry-run] systemd-run ... $DSH_BIN web --patch $DSH_HOME_DIR/modes/$mode.yml"
  else
    systemd-run --user --collect --unit=dsh-web \
      --property=StandardOutput=append:"$LOG_FILE" \
      --property=StandardError=append:"$LOG_FILE" \
      --property=WorkingDirectory="$HOME_DIR" \
      --setenv=HOME="$HOME_DIR" --setenv=DSH_HOME="$DSH_HOME_DIR" \
      "$DSH_BIN" web --patch "$DSH_HOME_DIR/modes/$mode.yml" >/dev/null
  fi
else
  say "no encuentro ninguna instancia de dsh web; no hay nada que reiniciar"
  exit 1
fi

if [ "$DRY" = "1" ]; then
  say "[dry-run] esperaria al puerto 3080 y guardaria la URL con token en $URL_FILE"
  exit 0
fi

for _ in $(seq 1 60); do
  if curl -s -m 1 http://127.0.0.1:3080/__dsh_fleet/status >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

url="$(grep -aoE 'http://127\.0\.0\.1:3080/\?token=[A-Za-z0-9_-]+' "$LOG_FILE" | tail -1 || true)"
if [ -n "$url" ]; then
  printf '%s\n' "$url" > "$URL_FILE"
  say "web arriba. URL nueva (guardada en $URL_FILE):"
  say "  $url"
else
  say "web arriba, pero no encontre el token en $LOG_FILE. Revisa el log."
fi

say
say "estado del plugin:"
curl -s http://127.0.0.1:3080/__dsh_fleet/status || say "  (sin respuesta)"
say
