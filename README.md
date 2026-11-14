# DSH Native Mode Router, Per-Session Isolation & Fleet Monitor (v3.0)

Production-grade **0 ms per-session in-memory engine switching**, complete **`team` preset isolation**, automatic turn recovery (Auto-Wakeup), and real-time fleet observability for DeepSeek Harness (DSH) on Linux (`127.0.0.1:3080`).

---

## 1. System Overview & v3.0 Architecture

DeepSeek Harness operates across 5 specialized presets depending on task complexity. Instead of restarting the entire server on every mode change or letting one project's mode leak into another, v3.0 delivers **100% per-session isolation**:

1. **0 ms In-Memory Switching for All 5 Modes (`standard`, `ptc`, `team`, `minimal`, `creator`)**: Calling `switch_mode({ mode, reason })` invokes `presets.recompose(agentCtx, targetPreset)` and appends `agent-preset/selected` solely for the calling session (`[MODO AISLADO]`).
2. **Zero Server Restarts & Zero Cross-Session Interference**: `dsh web` remains running smoothly on `--patch ~/.dsh/modes/standard.yml --no-open` (`state.json` stays `"standard"`). Other projects and tabs never change mode or lose running prompts.
3. **True `team` Preset Isolation + Clean Teardown**:
   - `preset-team` (`Modo Team`) is registered directly in `~/.dsh/profiles/web/cordis.patch.yml`.
   - `@deepseek-ai/dsh-experimental-tool-agent-team` dynamically mounts the 9 Team tools + `team:policy` + `team:identity` ONLY when `composedPreset === "team"` (or on teammates), and unmounts them immediately upon switching to `ptc`, `standard`, `minimal`, or `creator` (preventing leaks even inside `ptc`'s `run_code`).
   - `@deepseek-ai/dsh-experimental-client-ui-agent-team` renders the **`👥 Equipo de agentes`** button only when `leadPreset === "team"`.
4. **High-Availability Supervisor & Auto-Wakeup**: `dsh-supervisor.service` monitors port `3080` 24/7 with singleton PID lock (`~/.dsh/mode-router/supervisor.pid`), `--no-open` duplicate-tab protection, and `POST /__dsh_fleet/wake` recovery fallback.
5. **Full Session-Accurate Telemetry**: `dsh-top` scans complete `.zstd` logs (`agent-preset/selected`) + `session_projcache` to show each session's exact isolated `REAL MODE`.

```
                  ┌──────────────────────────────────────────────┐
                  │          Autonomous Agent Turn Loop          │
                  └──────────────────────┬───────────────────────┘
                                         │
                         Calls: switch_mode(mode, reason)
                                         │
                                         ▼
                 ┌────────────────────────────────────────────────┐
                 │  dsh-plugin-switch-mode (Per-Session, 0 ms)    │
                 │  - Validates preset: standard|ptc|team|minimal │
                 │    |creator (-> cordis)                        │
                 │  - presets.recompose(agentCtx, targetPreset)   │
                 │  - session.append('agent-preset/selected')     │
                 │  - tool-agent-team & ui-agent-team auto-sync   │
                 └───────────────────────┬────────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │  Isolated Session Resumes Immediately (0 ms) │
                  │  Other workspaces & host daemon untouched!   │
                  └──────────────────────────────────────────────┘
```

---

## 2. Directory Layout & Key Components

```
dsh-native-mode-router/
├── README.md                              # This master reference document
├── AGENTS.md                              # Global autonomous directives (symlinked to ~/.dsh/AGENTS.md)
├── SKILL.md                               # Canonical skill reference (symlinked to ~/.dsh/skills/dsh-native-modes/SKILL.md)
├── mode-router-real/
│   ├── README.md                          # Runtime, supervisor & patch script reference
│   ├── supervisor.mjs                     # Singleton supervisor (24/7 host watchdog & Auto-Wakeup fallback)
│   ├── apply-team-isolation-patches.sh    # Idempotent patcher/checker (--check) for @deepseek-ai/dsh updates
│   ├── modes/                             # Cordis YAML overlays (modes/team.yml = [] to avoid global leaks)
│   │   ├── standard.yml
│   │   ├── ptc.yml
│   │   ├── team.yml
│   │   ├── minimal.yml
│   │   └── creator.yml
│   └── plugin/                            # dsh-plugin-switch-mode Cordis tool plugin
│       ├── index.js                       # Registers switch_mode tool & in-memory preset switching
│       └── package.json
└── dsh-plugin-fleet-monitor/              # Web UI plugin & fleet management
    ├── install.sh                         # Installs plugins, dsh-top, dsh-open, optional .desktop entry
    ├── restart.sh                         # Clean service restart helper
    ├── lib/
    │   ├── index.js                       # Host endpoints: /__dsh_fleet/status, /wake, /launch-terminal
    │   └── client.js                      # Web frontend tab: Settings > Plugins > DSH Fleet Monitor
    ├── bin/
    │   ├── dsh-top                        # Real-time fleet monitor CLI (per-session real_mode resolution)
    │   ├── dsh-open                       # User launcher: opens active DSH Web URL in browser (avoids EADDRINUSE)
    │   └── dsh-empty                      # Helper CLI for cleaning empty archived/stale sessions
    ├── share/
    │   └── dsh-web.desktop                # Optional desktop/menu entry calling dsh-open
    └── package.json
```

---

## 3. The 5 Native Presets: Decision Matrix

Agents have full autonomous authority to chain engines across sub-phases at **0 ms cost** without asking permission:

| Engine | Native Preset | Primary Purpose | When An Agent Must Autonomously Switch |
|---|---|---|---|
| **`standard`** | `preset-standard` | `read`/`edit`/`write`, `bash`, `workflow`, `subagent`, `subagent_fork`, `tool-web`. | **Universal Default Mode**. Surgical code edits, git workflows, reading, unit tests, and final delivery. Return here when done in `ptc`/`team`/`minimal`. |
| **`ptc`** | `preset-ptc` | **`run_code`** in Node.js VM (wrapping tools programmatically + `subagent`). | **Mass loops & context savings**: inspecting/transforming >5-10 files, cross-referencing JSONs/logs, bulk regex, or chaining 10-20 tool calls in 1 turn. |
| **`team`** | `preset-team` (`Modo Team`) | **9 `agent-team` tools** + `team:policy` + `workflow` + Web UI panel. | **Modular parallel work**: Lead + up to 7 named durable teammates (`explorer`, `implementer`, `qa-auditor`), shared CAS task board, typed mailboxes. |
| **`minimal`** | `preset-minimal` | Persistent PTY bash shell (`bash-persistent`), minimal footprint. | **Interactive shell diagnostics**: sustained PTY troubleshooting or network/service debugging. |
| **`creator`** | `preset-cordis` | Standard toolset + `@deepseek-ai/dsh-tool-cordis`. | **Strictly for live Cordis container introspection**. NEVER switch to creator just to edit plugin source files (use `standard`). |

---

## 4. Autonomous Tool: `switch_mode` & Strategic Multi-Engine Chaining

Exported by `dsh-plugin-switch-mode` (`~/.dsh/profiles/web/node_modules/dsh-plugin-switch-mode`):

```json
switch_mode({
  "mode": "team",
  "reason": "Dividing architecture refactor across Explorer and Implementer teammates"
})
```

### Strategic Advantage Patterns (0 ms Chaining)
- **`standard -> ptc -> standard`**: Hop into `ptc` for batch computation/filtering over dozens of files via `run_code` in a single turn, then hop right back to `standard` for surgical edits.
- **`standard -> team -> standard`**: Hop into `team` for parallel implementation/review with disjoint `write_scopes`, then hop back to `standard` (unmounting all 9 team tools and the UI button cleanly).
- **`workflow` vs `team` vs `subagent`**:
  - Use **`team`** (`switch_mode({ mode: "team" })`) for durable interactive teammates + shared CAS board.
  - Use **`workflow`** (`tools.workflow`, available in `standard` AND `team`) whenever you need a **specific model per child** (`deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp` for images) or deterministic JS `parallel`/`pipeline`.
  - Use **`subagent` / `subagent_fork`** (in `standard` or `ptc`) for quick single subtasks using the default model.

---

### 4.1 Native Agent Teams (`team` Mode) Architecture & The 9 Tools

Registered in `~/.dsh/profiles/web/cordis.patch.yml` as `preset-team` alongside `@deepseek-ai/dsh-experimental-agent-team` (`maxMembers: 8`, `maxTasks: 256`, `maxMessageBytes: 65536`, `disposalTimeoutMs: 5000`), `@deepseek-ai/dsh-experimental-tool-agent-team` (`freshProvider: spawn`, `forkProvider: fork`), and `@deepseek-ai/dsh-experimental-client-ui-agent-team`.

The session acts as **Team Lead** (`lead`) with 9 coordination tools:

#### 1. Teammate Lifecycle Management
- **`spawn_teammate({ name, description, prompt, context })`** *(Lead only)*: Spawns durable named teammate (`fresh` or `fork`).
- **`list_agents({})`** *(Any member)*: Lists roster with roles and status (`running`, `inactive`, `provisioning`, `failed`).
- **`wait_agent({ timeout_ms })`** *(Any member)*: Waits for teammate/task activity (`10000`–`3600000` ms, default `30000`); returns `noProgress` immediately if no peer is active.
- **`interrupt_agent({ target })`** *(Lead only)*: Gracefully aborts a teammate's active turn while preserving its inbox.

#### 2. Inter-Agent Communication
- **`send_message({ target, message })`** *(Any member)*: Steers a `running` target at the nearest step boundary or wakes an `inactive` target. Returns `{ "sent": true }`.

#### 3. Shared CAS Task Board
- **`team_task_create({ subject, description, blocked_by, write_scopes })`** *(Any member)*: Creates a task with optional DAG blockers and advisory `write_scopes`.
- **`team_task_list({ status, owner, ready, cursor, limit })`** *(Any member)*: Lists tasks, `ownerName`, and `revision`.
- **`team_task_get({ task_id })`** *(Any member)*: Retrieves full task details and latest `revision`.
- **`team_task_update({ task_id, expected_revision, action, ... })`** *(Any member)*: Atomic Compare-And-Set (`claim`, `release`, `edit`, `set_dependencies`, `complete`, `reopen`, `reassign`, `delete`).

---

## 5. Systemd Daemon, Singleton Lock & Patch Maintenance

The supervisor runs 24/7 as a managed systemd user service with `--patch ~/.dsh/modes/standard.yml --no-open`:

```bash
systemctl --user status dsh-supervisor.service
systemctl --user restart dsh-supervisor.service
```

- **Singleton Lock (`~/.dsh/mode-router/supervisor.pid`)**: Prevents duplicate supervisors or port `3080` conflicts.
- **Post-Upgrade Patch Script (`mode-router-real/apply-team-isolation-patches.sh`)**:
  Re-applies the 3 global package patches (`dsh-experimental-tool-agent-team`, `dsh-experimental-client-ui-agent-team`, `dsh-llm-deepseek` `allDeferred`) after upgrading `@deepseek-ai/dsh`:
  ```bash
  bash mode-router-real/apply-team-isolation-patches.sh --check
  ```

---

## 6. Opening the Web UI (`dsh-open`) & Duplicate Tab Protection (`--no-open`)

Because `dsh-supervisor.service` owns port `3080` continuously, running `dsh web` manually fails with `listen EADDRINUSE`. Instead, use **`dsh-open`** (installed to `/usr/local/bin/dsh-open` by `dsh-plugin-fleet-monitor/install.sh`):

```bash
dsh-open              # Ensure supervisor is running and open the active token URL in your browser
dsh-open --url        # Print the active authenticated URL without launching a browser
dsh-open --status     # Check dsh-supervisor.service status
dsh-open --restart    # Restart dsh-supervisor.service and open the fresh URL
```

> [!TIP]
> Once opened once with `?token=...`, DSH issues a persistent signed `HttpOnly` cookie valid for 30 days (`cookieMaxAgeDays: 30`), allowing `http://127.0.0.1:3080/` to work across reboots in that browser. Pass `--desktop` to `dsh-plugin-fleet-monitor/install.sh` to install the application menu shortcut (`dsh-web.desktop`).

---

## 7. DeepSeek Messages API Patch (`defer_loading`)

When sessions dynamically toggle tools across presets, `tools` could all arrive with `deferLoading: true`, causing DeepSeek API to reject with `tools: at least one tool must have defer_loading=false`. The `allDeferred` guard in `@deepseek-ai/dsh-llm-deepseek` omits `defer_loading` in that edge case (checked and restored by `mode-router-real/apply-team-isolation-patches.sh`).

---

## 8. Fleet Observability: `dsh-top` CLI & Web Tab

- **Interactive CLI / Snapshot:** `/usr/local/bin/dsh-top` (or `/usr/local/bin/dsh-top --once`).
  - Reads full `.zstd` logs (`agent-preset/selected`) + `session_projcache` to show per-session `REAL MODE` (`👥 TEAM`, `⚡ STANDARD`, `⚙️ PTC`, `📟 MINIMAL`, `🛠️ CREATOR`).
- **Web UI Integration:** *Settings > Plugins > DSH Fleet Monitor* (live status + **"🚀 Abrir Terminal en Vivo"** button launching `dsh-top` on `DISPLAY=:0`).
