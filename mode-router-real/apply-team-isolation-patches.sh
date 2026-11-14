#!/usr/bin/env bash
# Aplica y verifica los parches de aislamiento por sesion (preset "team") y
# compatibilidad de herramientas diferidas dentro del paquete global @deepseek-ai/dsh.
#
# Estos 3 parches viven dentro de node_modules/@deepseek-ai/dsh y se pierden al
# actualizar dsh; ejecutar este script de forma idempotente tras cada update.
#
# Uso:
#   bash apply-team-isolation-patches.sh          # verifica y re-aplica si falta
#   bash apply-team-isolation-patches.sh --check  # solo comprueba estado (exit 0 = OK)

set -euo pipefail

CHECK_ONLY=0
if [ "${1:-}" = "--check" ]; then
  CHECK_ONLY=1
fi

DSH_BIN="$(command -v dsh || true)"
if [ -n "$DSH_BIN" ]; then
  DSH_REAL="$(readlink -f "$DSH_BIN")"
  DSH_PKG_ROOT="$(dirname "$(dirname "$DSH_REAL")")"
else
  DSH_PKG_ROOT="$HOME/.local/share/pi-node/node-v24.22.2-linux-x64/lib/node_modules/@deepseek-ai/dsh"
fi

DSH_NM="$DSH_PKG_ROOT/node_modules/@deepseek-ai"
if [ ! -d "$DSH_NM" ]; then
  echo "ERROR: no encuentro @deepseek-ai en $DSH_NM" >&2
  exit 1
fi

TOOL_TEAM_JS="$DSH_NM/dsh-experimental-tool-agent-team/lib/index.js"
UI_TEAM_JS="$DSH_NM/dsh-experimental-client-ui-agent-team/lib/client.js"
LLM_DEEPSEEK_JS="$DSH_NM/dsh-llm-deepseek/lib/index.js"
CORDIS_PATCH_YML="$HOME/.dsh/profiles/web/cordis.patch.yml"

for f in "$TOOL_TEAM_JS" "$UI_TEAM_JS" "$LLM_DEEPSEEK_JS"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: archivo esperado no encontrado: $f" >&2
    exit 1
  fi
done

echo "DSH_ROOT: $DSH_PKG_ROOT"

python3 - "$CHECK_ONLY" "$TOOL_TEAM_JS" "$UI_TEAM_JS" "$LLM_DEEPSEEK_JS" "$CORDIS_PATCH_YML" <<'PY'
import re
import shutil
import sys
import time
from pathlib import Path

check_only = sys.argv[1] == "1"
tool_team_path = Path(sys.argv[2])
ui_team_path = Path(sys.argv[3])
llm_ds_path = Path(sys.argv[4])
cordis_patch_path = Path(sys.argv[5])

errors = []
changed = []

def backup(path: Path):
    bak = Path(f"{path}.bak.{int(time.time())}")
    shutil.copy2(path, bak)

# ---------------------------------------------------------------------------
# 1. @deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js
#    Monta las 9 herramientas team + team:policy SOLO si composedPreset === "team"
#    (o si el agente es teammate) y las desmonta al cambiar a otro preset.
# ---------------------------------------------------------------------------
s1 = tool_team_path.read_text(encoding="utf-8")
marker1 = "ctx.agentPresets?.composedPreset?.(agent.ctx)"
if marker1 in s1 and '"agentPresets"' in s1 and 'ctx.on("agent-preset/selected"' in s1:
    print("[OK] tool-agent-team: aislamiento por preset 'team' activo.")
elif check_only:
    errors.append("tool-agent-team sin parche de aislamiento por preset 'team'")
else:
    old_inject = '''const inject = [
\t"agents",
\t"agentTeams",
\t"tools",
\t"systemPrompt"
];'''
    new_inject = '''const inject = [
\t"agents",
\t"agentTeams",
\t"agentPresets",
\t"tools",
\t"systemPrompt"
];'''
    old_apply_re = re.compile(
        r'function apply\(ctx, config = \{\}\) \{.*?\n\}\n//#endregion',
        re.DOTALL
    )
    new_apply = '''/** Install Team tools only in sessions whose active preset is "team" (and their teammates). */
function apply(ctx, config = {}) {
\tconst resolved = {
\t\tinterrupt: config.interrupt ?? true,
\t\tfreshProvider: config.freshProvider ?? "spawn",
\t\tforkProvider: config.forkProvider ?? "fork"
\t};
\tconst installed = /* @__PURE__ */ new Map();
\tconst syncing = /* @__PURE__ */ new Set();
\tconst isTeamActive = (agent) => {
\t\tconst membership = ctx.agentTeams.tryMembership(agent);
\t\tif (membership === void 0) return false;
\t\tif (membership.role === "teammate") return true;
\t\tconst rootSession = membership.root?.session ?? agent.session;
\t\tconst preset =
\t\t\tctx.agentPresets?.composedPreset?.(agent.ctx) ??
\t\t\t(rootSession && ctx.agentPresets?.presetForSession
\t\t\t\t? ctx.agentPresets.presetForSession(rootSession)
\t\t\t\t: void 0);
\t\treturn preset === "team";
\t};
\tconst syncAgent = (agent) => {
\t\tif (syncing.has(agent)) return;
\t\tsyncing.add(agent);
\t\ttry {
\t\t\tconst active = isTeamActive(agent);
\t\t\tif (active && !installed.has(agent)) {
\t\t\t\tinstalled.set(agent, install(agent, ctx, resolved));
\t\t\t} else if (!active && installed.has(agent)) {
\t\t\t\tconst dispose = installed.get(agent);
\t\t\t\tinstalled.delete(agent);
\t\t\t\tdispose?.();
\t\t\t}
\t\t} finally {
\t\t\tsyncing.delete(agent);
\t\t}
\t};
\tfor (const agent of ctx.agents.list()) syncAgent(agent);
\tctx.on("agent/created", ({ agent }) => {
\t\tsyncAgent(agent);
\t});
\tctx.on("agent-preset/selected", () => {
\t\tfor (const agent of ctx.agents.list()) syncAgent(agent);
\t});
\tctx.on("tools/change", () => {
\t\tfor (const agent of ctx.agents.list()) syncAgent(agent);
\t});
\tctx.on("agent/disposed", ({ agent }) => {
\t\tconst dispose = installed.get(agent);
\t\tinstalled.delete(agent);
\t\tdispose?.();
\t});
\tctx.effect(() => () => {
\t\tfor (const dispose of installed.values()) dispose();
\t\tinstalled.clear();
\t}, "tool-team.scopedTools()");
}
//#endregion'''

    updated1 = s1
    if '"agentPresets"' not in updated1:
        if old_inject not in updated1:
            errors.append("tool-agent-team: bloque inject inesperado; revisar manualmente")
        else:
            updated1 = updated1.replace(old_inject, new_inject, 1)
    if marker1 not in updated1:
        if not old_apply_re.search(updated1):
            errors.append("tool-agent-team: funcion apply() no encontrada")
        else:
            updated1 = old_apply_re.sub(lambda _m: new_apply, updated1, count=1)
    if not errors:
        backup(tool_team_path)
        tool_team_path.write_text(updated1, encoding="utf-8")
        changed.append("tool-agent-team")
        print("[PATCHED] tool-agent-team: aislamiento por preset 'team' aplicado.")

# ---------------------------------------------------------------------------
# 2. @deepseek-ai/dsh-experimental-client-ui-agent-team/lib/client.js
#    Oculta el boton "Equipo de agentes" cuando leadPreset !== "team".
# ---------------------------------------------------------------------------
s2 = ui_team_path.read_text(encoding="utf-8")
marker2a = "const leadPreset = useSessions((state) => state.byId[leadSessionId]?.projectionValues?.agentPreset);"
marker2b = 'if (leadPreset !== "team") return null;'
if marker2a in s2 and marker2b in s2:
    print("[OK] client-ui-agent-team: boton oculto fuera del preset 'team'.")
elif check_only:
    errors.append("client-ui-agent-team sin filtro leadPreset === 'team'")
else:
    anchor_lead = 'const leadSessionId = useSession((snapshot) => snapshot.subagent?.address.parentSessionId) ?? sessionId;'
    anchor_compact = 'const compact = team !== void 0 && team.members.length === 1 && team.tasks.length === 0;'
    updated2 = s2
    if anchor_lead not in updated2 or anchor_compact not in updated2:
        errors.append("client-ui-agent-team: puntos de insercion no encontrados")
    else:
        if marker2a not in updated2:
            updated2 = updated2.replace(anchor_lead, anchor_lead + "\n\t\t\t" + marker2a, 1)
        if marker2b not in updated2:
            updated2 = updated2.replace(anchor_compact, marker2b + "\n\t\t\t" + anchor_compact, 1)
        backup(ui_team_path)
        ui_team_path.write_text(updated2, encoding="utf-8")
        changed.append("client-ui-agent-team")
        print("[PATCHED] client-ui-agent-team: filtro leadPreset === 'team' aplicado.")

# ---------------------------------------------------------------------------
# 3. @deepseek-ai/dsh-llm-deepseek/lib/index.js
#    Evita error de API DeepSeek ("at least one tool must have defer_loading=false").
# ---------------------------------------------------------------------------
s3 = llm_ds_path.read_text(encoding="utf-8")
marker3 = "const allDeferred = options.tools.length > 0 && options.tools.every((t) => t.deferLoading === true);"
if marker3 in s3:
    print("[OK] dsh-llm-deepseek: guarda allDeferred (defer_loading) activa.")
elif check_only:
    errors.append("dsh-llm-deepseek sin guarda allDeferred")
else:
    old_tools = '''\t\t...options.tools === void 0 ? {} : { tools: options.tools.map((tool) => ({
\t\t\tname: tool.name,
\t\t\tdescription: tool.description,
\t\t\tinput_schema: tool.parameters,
\t\t\t...tool.deferLoading === true ? { defer_loading: true } : {}
\t\t})) }'''
    new_tools = '''\t\t...options.tools === void 0 ? {} : { tools: (() => {
\t\t\tconst allDeferred = options.tools.length > 0 && options.tools.every((t) => t.deferLoading === true);
\t\t\treturn options.tools.map((tool) => ({
\t\t\t\tname: tool.name,
\t\t\t\tdescription: tool.description,
\t\t\t\tinput_schema: tool.parameters,
\t\t\t\t...(tool.deferLoading === true && !allDeferred ? { defer_loading: true } : {})
\t\t\t}));
\t\t})() }'''
    if s3.count(old_tools) != 1:
        errors.append("dsh-llm-deepseek: bloque deferLoading inesperado; revisar manualmente")
    else:
        backup(llm_ds_path)
        llm_ds_path.write_text(s3.replace(old_tools, new_tools, 1), encoding="utf-8")
        changed.append("dsh-llm-deepseek")
        print("[PATCHED] dsh-llm-deepseek: guarda allDeferred aplicada.")

# ---------------------------------------------------------------------------
# 4. Verificar registro de preset-team en ~/.dsh/profiles/web/cordis.patch.yml
# ---------------------------------------------------------------------------
if cordis_patch_path.exists():
    cp = cordis_patch_path.read_text(encoding="utf-8")
    if "id: preset-team" in cp and "id: tool-agent-team" in cp and "id: ui-agent-team" in cp:
        print("[OK] cordis.patch.yml: preset-team y servicios agent-team registrados.")
    else:
        errors.append("cordis.patch.yml: falta preset-team o servicios agent-team")
else:
    errors.append(f"cordis.patch.yml no encontrado en {cordis_patch_path}")

if errors:
    for e in errors:
        print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(2)

if changed:
    print("\nParches re-aplicados: " + ", ".join(changed))
    print("Reinicia el servicio para cargar el bundle actualizado: systemctl --user restart dsh-supervisor.service")
PY
