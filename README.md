# DSH Native Mode Router, Auto-Wakeup & Fleet Monitor

Production-grade autonomous engine switching, automatic turn resumption (Auto-Wakeup), and real-time fleet observability for DeepSeek Harness (DSH) on Linux Mint (`127.0.0.1:3080`).

---

## 1. System Overview & Architecture

DeepSeek Harness operates across multiple specialized engines depending on task complexity. Rather than forcing agents to stay in one preset or restarting sessions manually, this project implements an autonomous runtime that:
1. Allows agents to switch engines dynamically in ~1.2s using `switch_mode`.
2. Automatically wakes up the calling agent turn upon engine reload via the `POST /__dsh_fleet/wake` webhook.
3. Protects the runtime with a singleton PID lock (`~/.dsh/mode-router/supervisor.pid`) and runs 24/7 as a systemd user daemon (`dsh-supervisor.service`).
4. Prevents duplicate browser tabs by enforcing `--no-open` on all server reboots.
5. Provides both human and AI fleet visibility across 30+ workspaces and 70+ agents via `dsh-top` and `dsh-plugin-fleet-monitor`.

```
                  ┌──────────────────────────────────────────────┐
                  │          Autonomous Agent Turn Loop          │
                  └──────────────────────┬───────────────────────┘
                                         │
                         Calls: switch_mode(mode, reason)
                                         │
                                         ▼
                 ┌────────────────────────────────────────────────┐
                 │ Writes ~/.dsh/mode-router/request.json        │
                 └───────────────────────┬────────────────────────┘
                                         │  (Hot-switch in ~1.2s)
                                         ▼
                 ┌────────────────────────────────────────────────┐
                 │       dsh-supervisor (PID singleton lock)      │
                 │   - Graceful SIGTERM of current DSH engine     │
                 │   - Spawns: dsh web --patch <mode>.yml --no-open│
                 │   - Waits for 127.0.0.1:3080 to respond       │
                 └───────────────────────┬────────────────────────┘
                                         │
                                         ▼
                 ┌────────────────────────────────────────────────┐
                 │    POST /__dsh_fleet/wake (Auto-Wakeup)       │
                 │   - Dispatched by supervisor to DSH host       │
                 │   - Calls sessionController.commands.prompt()  │
                 │   - Injects resumption prompt with wakeup: true│
                 └───────────────────────┬────────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │    Agent Turn Automatically Resumes          │
                  │    Continues task in new engine seamlessly!   │
                  └──────────────────────────────────────────────┘
```

---

## 2. Directory Layout & Key Components

```
dsh-native-mode-router/
├── README.md                      # This master reference document
├── AGENTS.md                      # Global autonomous directives (symlinked to ~/.dsh/AGENTS.md)
├── SKILL.md                       # Canonical skill reference (symlinked to ~/.dsh/skills/dsh-native-modes/SKILL.md)
├── mode-router-real/
│   ├── supervisor.mjs             # Singleton supervisor managing DSH engine lifecycle & auto-wake
│   ├── modes/                     # Official Cordis YAML mode patch overlays
│   │   ├── standard.yml           # Base default engine (surgical file editing, standard JSON-RPC)
│   │   ├── ptc.yml                # Programmatic Tool Calling (TypeScript VM run_code execution)
│   │   ├── team.yml               # Native Agent Teams (@deepseek-ai/dsh-experimental-agent-team: Lead + 8 teammates, CAS task board, ui-agent-team)
│   │   ├── minimal.yml            # Interactive persistent PTY bash shell (minimal TTFT <0.5s)
│   │   └── creator.yml            # Cordis plugin development & introspection runtime
│   └── plugin/                    # dsh-plugin-switch-mode Cordis tool plugin
│       ├── index.js               # Registers switch_mode tool, dual-path switching & session event logging
│       └── package.json
└── dsh-plugin-fleet-monitor/      # Web UI plugin & fleet management
    ├── lib/
    │   ├── index.js               # Host endpoints: /__dsh_fleet/status, /wake, /launch-terminal
    │   └── client.js              # Web frontend tab: Settings > Plugins > DSH Fleet Monitor
    ├── bin/
    │   ├── dsh-top                # Standalone curses-like real-time fleet monitor CLI (with real_mode resolution)
    │   └── dsh-open               # User launcher: opens active DSH Web URL with token in browser (avoids EADDRINUSE)
    ├── share/
    │   └── dsh-web.desktop        # Optional desktop/menu entry calling dsh-open
    └── package.json
```

---

## 3. The 5 Native Engines: Decision Matrix

Agents have full autonomous authority to switch engines to match task requirements without asking unnecessary user permission:

| Engine | Cordis Patch | Primary Purpose | When An Agent Must Autonomously Switch |
|---|---|---|---|
| **`standard`** | `~/.dsh/modes/standard.yml` | General software engineering, surgical file editing, and Git workflows. | **Universal Default Engine**. Use for reading/writing code, bug fixing, single-file edits, and standard shell tasks. |
| **`ptc`** | `~/.dsh/modes/ptc.yml` | Programmatic Tool Calling via `run_code` in Node.js VM. | **Mandatory for mass loops and data calculation**: processing arrays >10 items, batch transforming files, mass regex, or chaining 20 operations in a single turn without token blowout. |
| **`team`** | `~/.dsh/modes/team.yml` | Native Experimental Agent Teams (`agent-team`). | **Mandatory for modular multi-agent tasks**: large objectives requiring parallel specialization (Explorer, Implementer, Auditor), shared CAS task board, and typed mailboxes. |
| **`minimal`** | `~/.dsh/modes/minimal.yml` | Interactive persistent PTY bash shell (`@deepseek-ai/dsh-tool-bash-persistent`). | **Mandatory for fast interactive shell diagnostics**: network tests, long-running terminal programs, or immediate TTFT <0.5s CLI interaction. |
| **`creator`** | `~/.dsh/modes/creator.yml` | Cordis plugin development & host introspection. | **Strictly for live Cordis container debugging**. NEVER switch to creator just to edit plugin source files (use `standard`). |

---

## 4. Autonomous Tool: `switch_mode` & Dual-Path Architecture

The tool is exported by `dsh-plugin-switch-mode` and available to all agents across all sessions:

```json
switch_mode({
  "mode": "team",
  "reason": "Dividing architecture refactor across Explorer and Implementer teammates"
})
```

### Dual-Path Switching Architecture:
1. **In-Memory Recompose (Fast Path)**: If the target mode can be satisfied within the active agent preset registry (`ctx.agentPresets.recompose`), the runtime recompiles the container instantly without restarting DSH or disturbing other workspaces.
2. **Supervisor Daemon Reload (Engine Overlay Path)**: For overlays like `team.yml` or `ptc.yml` that add or replace native Cordis services, the tool writes `{ mode, reason, sessionId, at, pid }` to `~/.dsh/mode-router/request.json`.
   - The systemd supervisor daemon (`dsh-supervisor.service`) intercepts the request in <500ms.
   - Gracefully stops the current DSH instance and restarts DSH with `--patch ~/.dsh/modes/<mode>.yml --no-open` (~1.2s reboot time).
   - Once port `3080` answers, the supervisor issues `POST /__dsh_fleet/wake`.
   - The fleet host plugin delivers the continuation prompt (`wakeup: true`) directly into the agent's turn.
3. **Session Log Synchronization**: Both switching paths append an `agent-preset/selected` event to the session storage. This guarantees that `dsh-top` and the Web UI immediately reflect the new active engine in the `REAL MODE` telemetry column.

---

### 4.1 Native Agent Teams (`team` Mode) Architecture & The 9 Tools

When switched to `team` mode, legacy subagent tools (`tool-subagent`, `tool-subagent-fork`, `tool-subagent-control`) are disabled. DSH mounts the official `@deepseek-ai/dsh-experimental-agent-team` stack (configured with `maxMembers: 8`, `maxTasks: 256`, `freshProvider: spawn`, `forkProvider: fork`, and `ui-agent-team`).

The session functions as the **Team Lead** (`lead`) with access to 9 native coordination tools:

#### 1. Teammate Lifecycle Management
- **`spawn_teammate({ name, description, prompt, context })`** *(Lead only)*:
  - Spawns a durable named teammate agent.
  - `name`: Unique lower-kebab-case identifier (e.g. `explorer`, `implementer`, `qa-auditor`).
  - `description`: Short functional responsibility.
  - `prompt`: Self-contained mission brief with explicit objectives.
  - `context`: `"fresh"` (clean context window, default) or `"fork"` (inherits parent conversation history).
- **`list_agents({})`** *(Any member)*:
  - Returns the roster of all team members with their roles and availability status (`running`, `inactive`, `provisioning`, `failed`).
  - *Note*: `inactive` indicates the agent's turn concluded and it is awaiting its next message or task; it does NOT mean it was terminated.
- **`wait_agent({ timeout_ms })`** *(Any member)*:
  - Non-blocking synchronization waiting for teammate activity or task state transitions (timeout 10,000ms to 3,600,000ms, default 30,000ms).
  - Immediately returns `noProgress` if no peer is active, preventing busy polling loops.
- **`interrupt_agent({ target })`** *(Lead only)*:
  - Gracefully aborts a teammate's active turn while preserving its message queue and state.

#### 2. Inter-Agent Communication
- **`send_message({ target, message })`** *(Any member)*:
  - Delivers a typed message to `target` (`"lead"` or teammate name).
  - Wakes up an `inactive` member immediately or queues for the next step boundary if currently executing. Returns `{ "sent": true }`.

#### 3. Shared CAS Task Board
- **`team_task_create({ subject, description, blocked_by, write_scopes })`** *(Any member)*:
  - Adds a new task to the team board.
  - `blocked_by`: Array of prerequisite task IDs establishing DAG dependency order.
  - `write_scopes`: Advisory workspace subpaths to prevent concurrent edits (e.g. `["src/backend/"]`).
- **`team_task_list({ status, owner, ready, cursor, limit })`** *(Any member)*:
  - Queries the board with status filters (`pending`, `in_progress`, `completed`). Returns task IDs, current owners, and current `revision`.
- **`team_task_get({ task_id })`** *(Any member)*:
  - Retrieves full task specification and latest `revision` before initiating modifications.
- **`team_task_update({ task_id, expected_revision, action, ... })`** *(Any member)*:
  - **Atomic Compare-And-Set (CAS)**: `expected_revision` MUST match the board's current revision number, preventing race conditions among concurrent teammates.
  - `action`: `"claim"`, `"release"`, `"edit"`, `"set_dependencies"`, `"complete"`, `"reopen"`, `"reassign"`, `"delete"`.

---

## 5. Systemd Daemon & Singleton Lock

The supervisor runs 24/7 as a managed systemd user service with Linux user lingering enabled:

```bash
# Service status
systemctl --user status dsh-supervisor.service

# Restart supervisor
systemctl --user restart dsh-supervisor.service
```

### Singleton Lock (`~/.dsh/mode-router/supervisor.pid`):
- Any attempt to run a secondary supervisor (e.g. `node supervisor.mjs`) checks the PID inside `supervisor.pid`.
- If the PID is active, the second instance aborts immediately with exit code 1:
  `ABORTADO: ya hay un supervisor vivo (pid <PID>), no arranco otro`.
- Prevents split-brain races, corrupted `request.json` polling, and port 3080 conflicts.

---

## 6. Opening the Web UI (`dsh-open`) & Duplicate Tab Protection (`--no-open`)

When `dsh web` boots without `--no-open`, it calls the OS default browser launcher on every boot. Because mode switches reload DSH, this previously opened a new tab on every switch.

Enforcing `['web', '--patch', patch, '--no-open']` in `supervisor.mjs` ensures:
- DSH Web starts silently on `http://127.0.0.1:3080`.
- Existing open browser tabs automatically reconnect their WebSocket.
- Exactly zero unwanted tabs are spawned.

Because `dsh-supervisor.service` already owns port `3080` in the background, running `dsh web` manually fails with `listen EADDRINUSE: address already in use 127.0.0.1:3080`. Instead, use the companion launcher **`dsh-open`** (installed to `/usr/local/bin/dsh-open` by `dsh-plugin-fleet-monitor/install.sh`):

```bash
dsh-open              # Ensure supervisor is running and open the active token URL in your browser
dsh-open --url        # Print the active authenticated URL without launching a browser
dsh-open --status     # Check dsh-supervisor.service status
dsh-open --restart    # Restart dsh-supervisor.service and open the fresh URL
```

> [!TIP]
> Once opened once with `?token=...`, DSH issues a persistent signed `HttpOnly` cookie valid for 30 days (`cookieMaxAgeDays: 30`), allowing `http://127.0.0.1:3080/` to work across reboots and mode switches in that browser. Pass `--desktop` to `dsh-plugin-fleet-monitor/install.sh` to install the application menu shortcut (`dsh-web.desktop`).

---

## 7. DeepSeek Messages API Patch (`defer_loading`)

**Root cause:** When DSH resumed sessions across mode changes, all newly exposed tools were initialized with `deferLoading: true`. The DeepSeek API rejected the request with `tools: at least one tool must have defer_loading=false. All tools cannot be deferred.`.

**Upstream fix in `@deepseek-ai/dsh-llm-deepseek` (or `packages/llm/llm-deepseek/src/serialize.ts`):**
If all tools are marked with `deferLoading === true`, the `defer_loading` flag is omitted, making all tools immediately admitted by the API without errors.

---

## 8. Fleet Observability: `dsh-top` CLI & Web Tab

Humans and agents can monitor all 30+ workspaces and 70+ fleet sessions in real time:

- **Interactive CLI:** Run `/usr/local/bin/dsh-top` (or `dsh-mode --live`).
  - Auto-refreshes every 1.5s.
  - **Accurate Real Mode Telemetry:** `real_mode` resolves the effective engine directly from the session's recorded preset log (`agent-preset/selected`), displaying `\033[1;34m👥 TEAM\033[0m`, `⚡ STANDARD`, `⚙️ PTC`, `📟 MINIMAL`, or `🛠️ CREATOR`.
  - **Hotkeys:**
    - `p` / `s` / `t` / `m` / `c`: Request global engine switch (`t` switches to `team` mode) and confirm with `y`.
    - `a`: Toggle visibility of subagents / teammates (`delegationDepth > 0`).
    - `o`: Toggle visibility of orphaned sessions from deleted workspaces.
    - `f`: Filter sessions (all sessions vs active in last 24h).
    - `q`: Quit monitor.
- **Web UI Integration:** Go to *Settings > Plugins > DSH Fleet Monitor* in the DSH web interface.
  - Displays live engine status, uptime, and active session count.
  - Includes button: **"🚀 Abrir Terminal en Vivo"** which launches `gnome-terminal` on `DISPLAY=:0` running `dsh-top`.
