# mode-router-real — Runtime Architecture, Supervisor & Patch Reference (v3.0)

Per-session 0 ms in-memory engine router, high-availability supervisor watchdog, and idempotent isolation patcher for DeepSeek Harness (`127.0.0.1:3080`).

## Subsystems

| Component | Path | Function | Status |
|---|---|---|---|
| **Switch Mode Plugin** | `plugin/index.js` | Cordis host tool `switch_mode(mode, reason)`. Recomposes active session preset (`standard`, `ptc`, `team`, `minimal`, `cordis`) in 0 ms in memory (`[MODO AISLADO]`). | Active (`~/.dsh/profiles/web/node_modules/dsh-plugin-switch-mode`) |
| **Supervisor Daemon** | `supervisor.mjs` | Singleton daemon keeping `dsh web` running 24/7 with `--patch ~/.dsh/modes/standard.yml --no-open` and `POST /__dsh_fleet/wake` recovery fallback. | Managed by `dsh-supervisor.service` |
| **Isolation Patcher** | `apply-team-isolation-patches.sh` | Verifies (`--check`) and re-applies the 3 global `@deepseek-ai/dsh` patches (`tool-agent-team`, `client-ui-agent-team`, `dsh-llm-deepseek` `allDeferred`). | Idempotent maintenance script |
| **Engine Overlays** | `modes/*.yml` | Legacy/base YAML overlays (`standard.yml` and `team.yml` are `[]` so per-session preset isolation governs `team` without disabling subagents globally). | Synced with `~/.dsh/modes/` |

## Architecture v3.0: How Isolation Works

1. **All 5 Modes Are Native Presets**: `preset-standard`, `preset-ptc`, `preset-minimal`, `preset-cordis` (alias `creator`), and `preset-team` (`Modo Team`, registered in `~/.dsh/profiles/web/cordis.patch.yml`).
2. **In-Memory Switching (`0 ms`, zero restarts)**: `switch_mode({ mode, reason })` calls `await presets.recompose(agentCtx, targetPreset)` and appends `agent-preset/selected` ONLY to the calling session. Neither `dsh web` nor other open workspaces restart or change mode; `~/.dsh/mode-router/state.json` stays `"standard"`.
3. **Clean `team` Teardown**:
   - `dsh-experimental-tool-agent-team/lib/index.js` listens to `agent/created`, `agent-preset/selected`, and `tools/change`, mounting the 9 team tools + `team:policy` + `team:identity` ONLY when `composedPreset(agent.ctx) === "team"` (or on teammates), and disposing them immediately when switching to `ptc`, `standard`, `minimal`, or `creator`.
   - `dsh-experimental-client-ui-agent-team/lib/client.js` renders the `👥 Equipo de agentes` header button only when `leadPreset === "team"`.

## Management & Verification Commands

```bash
# Check supervisor service status
systemctl --user status dsh-supervisor.service

# Audit global package patches + cordis.patch.yml preset-team
bash mode-router-real/apply-team-isolation-patches.sh --check

# Re-apply patches after upgrading @deepseek-ai/dsh
bash mode-router-real/apply-team-isolation-patches.sh

# Inspect per-session real modes without touching state.json
dsh-top --once
```
