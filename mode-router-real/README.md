# mode-router-real — Runtime Architecture & Supervisor Reference

Production hot-switching engine and Auto-Wakeup daemon for DeepSeek Harness (DSH Web) on Linux Mint (`127.0.0.1:3080`).

## Subsystems

| Component | Path | Function | Production Status |
|---|---|---|---|
| **Switch Mode Plugin** | `plugin/index.js` | Cordis host tool `switch_mode(mode, reason)`. Dual-path: in-memory recompose + supervisor request file. | Active (`~/.dsh/profiles/web/node_modules/dsh-plugin-switch-mode`) |
| **Supervisor Daemon** | `supervisor.mjs` | Singleton daemon managing `--patch` lifecycle, Auto-Wakeup, and `--no-open` tab protection. | Managed by `dsh-supervisor.service` (systemd user unit) |
| **Engine Overlays** | `modes/*.yml` | Cordis YAML overlays: `standard.yml`, `ptc.yml`, `team.yml`, `minimal.yml`, `creator.yml`. | Active in `~/.dsh/modes/` and tracked in repo `modes/` |

## Operational Architecture & Production Verification

- **Production Service**: The supervisor runs 24/7 as a managed systemd user service (`systemctl --user status dsh-supervisor.service`) with Linux lingering enabled.
- **Dual-Path Switching**: Mode switching combines in-memory preset switching with supervisor `--patch` overlays. Deep overlays (`team`, `ptc`) use supervisor restart to cleanly mount native Cordis plugins and tools in ~1.2s.
- **Auto-Wakeup**: When DSH reboots, `supervisor.mjs` issues `POST /__dsh_fleet/wake` with `{ sessionId, mode, reason }`. The plugin injects the prompt so the agent resumes inference automatically without human intervention.
- **Duplicate Tab Protection**: DSH is invoked with `['web', '--patch', patch, '--no-open']`, completely preventing browser tab clutter.
- **Singleton PID Guard**: `~/.dsh/mode-router/supervisor.pid` enforces exactly one running supervisor instance, eliminating split-brain races and port 3080 conflicts.

## Team Mode Configuration (`modes/team.yml`)

`team.yml` replaces legacy single-threaded subagents with DeepSeek's experimental agent-team stack:
- Disables: `tool-subagent-control`, `tool-subagent`, `tool-subagent-fork`.
- Enables: `@deepseek-ai/dsh-experimental-agent-team` (configured with `maxMembers: 8`, `maxTasks: 256`, `maxMessageBytes: 65536`, `disposalTimeoutMs: 5000`).
- Enables: `@deepseek-ai/dsh-experimental-tool-agent-team` (configured with `freshProvider: spawn`, `forkProvider: fork`).
- Enables: `@deepseek-ai/dsh-experimental-client-ui-agent-team` (Web UI team monitor).

## Management Commands

```bash
# Check service status
systemctl --user status dsh-supervisor.service

# View live supervisor logs
journalctl --user -u dsh-supervisor.service -f

# Safe restart
systemctl --user restart dsh-supervisor.service
```
