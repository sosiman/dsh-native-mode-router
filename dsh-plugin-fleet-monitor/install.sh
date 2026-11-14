#!/usr/bin/env bash
# Instalador idempotente de dsh-plugin-fleet-monitor en un perfil de DSH.
#
#   bash install.sh                 # instala en el perfil web (copia) + dsh-top + dsh-open
#   bash install.sh --link          # enlaza en vez de copiar (modo desarrollo)
#   bash install.sh --profile acp   # otro perfil
#   bash install.sh --no-bin        # no toca /usr/local/bin/{dsh-top,dsh-open}
#   bash install.sh --desktop       # instala entrada de menu ~/.local/share/applications/dsh-web.desktop
#   bash install.sh --check         # solo comprueba el estado
#
# Copiar (no enlazar) es lo recomendado: asi el plugin sobrevive a cambios en la
# carpeta del proyecto y OJO, los cambios posteriores en el codigo host requieren
# reiniciar dsh web (el bundle cliente si se recarga solo).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="web"
MODE="copy"
INSTALL_BIN=1
INSTALL_DESKTOP=0
CHECK_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --link) MODE="link"; shift ;;
    --copy) MODE="copy"; shift ;;
    --profile) PROFILE="${2:?falta el nombre del perfil}"; shift 2 ;;
    --no-bin) INSTALL_BIN=0; shift ;;
    --desktop) INSTALL_DESKTOP=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "opcion desconocida: $1" >&2; exit 2 ;;
  esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PTARGET="$DSH_HOME/profiles/$PROFILE"
NM="$PTARGET/node_modules"
PATCH="$PTARGET/cordis.patch.yml"
PKG="dsh-plugin-fleet-monitor"
ENTRY_ID="fleet-monitor"

say() { printf '%s\n' "$*"; }

check() {
  local fail=0
  say "== estado =="
  say "fuente:        $SRC"
  if [ -e "$NM/$PKG" ]; then
    if [ -L "$NM/$PKG" ]; then
      say "instalado:     enlace -> $(readlink -f "$NM/$PKG")"
    else
      say "instalado:     copia en $NM/$PKG"
    fi
  else
    say "instalado:     NO"
    fail=1
  fi
  if [ -f "$PATCH" ] && grep -q "id: $ENTRY_ID" "$PATCH"; then
    say "cordis.patch:  entrada '$ENTRY_ID' presente"
  else
    say "cordis.patch:  entrada '$ENTRY_ID' AUSENTE"
    fail=1
  fi
  if command -v dsh-top >/dev/null 2>&1; then
    say "dsh-top:       $(command -v dsh-top)"
  else
    say "dsh-top:       AUSENTE (se instala en /usr/local/bin)"
    fail=1
  fi
  if command -v dsh-open >/dev/null 2>&1; then
    say "dsh-open:      $(command -v dsh-open)"
  else
    say "dsh-open:      AUSENTE (se instala en /usr/local/bin)"
    fail=1
  fi
  if curl -s -m 3 http://127.0.0.1:3080/__dsh_fleet/status >/dev/null 2>&1; then
    say "ruta host:     /__dsh_fleet/status responde"
  else
    say "ruta host:     no responde (dsh web parado o plugin sin cargar)"
  fi
  say "pruebas:       node tests/test-host.mjs | python3 tests/test-dsh-top.py"
  return "$fail"
}

if [ "$CHECK_ONLY" = "1" ]; then
  check
  exit $?
fi

say "== instalando $PKG en el perfil '$PROFILE' =="
mkdir -p "$NM"

if [ ! -f "$PTARGET/package.json" ]; then
  say "AVISO: $PTARGET/package.json no existe; ¿perfil correcto?" >&2
fi

rm -rf "$NM/$PKG"
if [ "$MODE" = "link" ]; then
  ln -s "$SRC" "$NM/$PKG"
  say "enlazado: $NM/$PKG -> $SRC"
else
  mkdir -p "$NM/$PKG"
  cp -a "$SRC/lib" "$SRC/bin" "$SRC/package.json" "$NM/$PKG/"
  if [ -f "$SRC/README.md" ]; then cp -a "$SRC/README.md" "$NM/$PKG/"; fi
  find "$NM/$PKG" -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
  chmod -R u+rwX,go+rX "$NM/$PKG"
  say "copiado:  $NM/$PKG"
fi

if [ -f "$PATCH" ] && grep -q "id: $ENTRY_ID" "$PATCH"; then
  say "cordis.patch.yml ya tenia la entrada '$ENTRY_ID'"
else
  mkdir -p "$PTARGET"
  touch "$PATCH"
  {
    printf '\n- insert:\n'
    printf '    - id: %s\n' "$ENTRY_ID"
    printf '      name: %s\n' "$PKG"
  } >> "$PATCH"
  say "cordis.patch.yml: entrada '$ENTRY_ID' anadida"
fi

install_usr_bin() {
  local src="$1"
  local name="$2"
  if [ "$(id -u)" = "0" ]; then
    install -m 755 "$src" "/usr/local/bin/$name"
    say "$name instalado en /usr/local/bin/$name"
  elif sudo -n true 2>/dev/null; then
    sudo -n install -m 755 "$src" "/usr/local/bin/$name"
    say "$name instalado en /usr/local/bin/$name"
  else
    say "AVISO: sin sudo no puedo instalar /usr/local/bin/$name." >&2
    say "       ejecuta: sudo install -m 755 '$src' '/usr/local/bin/$name'" >&2
  fi
}

if [ "$INSTALL_BIN" = "1" ]; then
  install_usr_bin "$SRC/bin/dsh-top" dsh-top
  install_usr_bin "$SRC/bin/dsh-open" dsh-open
fi

if [ "$INSTALL_DESKTOP" = "1" ] && [ -f "$SRC/share/dsh-web.desktop" ]; then
  APP_DIR="$HOME/.local/share/applications"
  ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
  mkdir -p "$APP_DIR" "$ICON_DIR"
  ICON_SRC="$(node -e "try{console.log(require('path').join(require('path').dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')),'dist','icon-512.png'))}catch{}" 2>/dev/null || true)"
  if [ -n "$ICON_SRC" ] && [ -f "$ICON_SRC" ]; then
    cp -f "$ICON_SRC" "$ICON_DIR/dsh-web.png"
  fi
  install -m 755 "$SRC/share/dsh-web.desktop" "$APP_DIR/dsh-web.desktop"
  update-desktop-database "$APP_DIR" 2>/dev/null || true
  say "entrada de menu instalada en $APP_DIR/dsh-web.desktop"
fi

say
say "== comprobaciones de sintaxis =="
node --check "$SRC/lib/index.js" && say "  host OK"
node --check "$SRC/lib/client.js" && say "  cliente OK"
python3 -m py_compile "$SRC/bin/dsh-top" && say "  dsh-top OK"
bash -n "$SRC/bin/dsh-open" && say "  dsh-open OK"

say
say "== siguiente paso =="
say "  El bundle CLIENTE se recarga solo (dsh-client-hmr): refresca el navegador."
say "  El codigo HOST solo se recarga al arrancar dsh web. Si ya estaba cargado"
say "  antes de este cambio, reinicia:   bash '$SRC/restart.sh'"
say "  Comprueba con:  curl -s http://127.0.0.1:3080/__dsh_fleet/status"
