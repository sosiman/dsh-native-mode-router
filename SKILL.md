---
name: dsh-native-modes
description: "Autonomous 0ms per-session in-memory switching across all 5 DeepSeek Harness native presets (Standard, PTC, Team, Minimal, Creator) using switch_mode, with full Agent Team orchestration (9 tools), clean tool/UI teardown, and strategic multi-engine chaining."
version: 3.0.0
author: LOKTAR Multi-Agent Architecture
platforms: [linux]
metadata:
  tags: [dsh, switch_mode, ptc, team, minimal, standard, creator, in-memory, per-session, agent-team, multi-agent]
---

# DeepSeek Harness Native Engines & Per-Session In-Memory Switching (v3.0)

This skill is the authoritative guide for AI agents operating inside DeepSeek Harness (DSH).

---

## 1. Per-Session In-Memory Architecture (0 ms, Zero Restarts)

> [!NOTE]
> **DSH Web runs 24/7 on `127.0.0.1:3080` under systemd (`dsh-supervisor.service`) with 100% per-session engine isolation.**
> All autonomous agents have full authority to switch execution engines via `switch_mode({ mode, reason })` without asking the user for permission.

In v3.0, all 5 engines are registered as native `@deepseek-ai/dsh-agent-preset` definitions (`preset-standard`, `preset-ptc`, `preset-minimal`, `preset-cordis`, and `preset-team` in `~/.dsh/profiles/web/cordis.patch.yml`):

1. **Instant Recomposition (`0 ms`)**: Calling `switch_mode({ mode, reason })` executes `await presets.recompose(agentCtx, targetPreset)` and appends `agent-preset/selected` directly in memory (`[MODO AISLADO]`) for your session only.
2. **Zero Server Restarts**: Switching between `standard`, `ptc`, `team`, `minimal`, or `creator` (in any direction, including `team -> ptc` and `team -> standard`) **never restarts `dsh web`**, keeps your conversation state intact, and leaves the host daemon stable on `--patch ~/.dsh/modes/standard.yml --no-open` (`state.json` stays `"standard"`).
3. **Zero Cross-Session Interference**: Other workspaces and browser tabs remain completely untouched in their own independent presets.
4. **Clean `team` Tool & UI Teardown**:
   - Entering `team` (`Modo Team`) dynamically mounts the 9 `agent-team` tools + `team:policy` + `team:identity`, enables the **`👥 Equipo de agentes`** header button in that session, retains `workflow`, and omits `subagent`/`subagent_fork`.
   - Leaving `team` for `ptc`, `standard`, `minimal`, or `creator` immediately disposes the 9 `agent-team` tools and `team:policy` (not even reachable inside `ptc`'s `run_code`) and hides the **`👥 Equipo de agentes`** button in the UI.

### The 5 Native Presets: Decision Matrix

| Mode | Native Preset | Exposed Capabilities | When An Agent Must Autonomously Switch (0 ms) |
|---|---|---|---|
| **`standard`** | `preset-standard` | `read`/`edit`/`write`, `bash`, `grep`/`glob`, `workflow`, `subagent`, `subagent_fork`, `tool-web`. | **Universal Base Mode**. Use for targeted edits, file reading, Git, unit tests, and final delivery. Always switch back to `standard` after finishing specialized phases. |
| **`ptc`** | `preset-ptc` | **`run_code`** (Node.js VM programmatic tool execution) + `subagent`/`subagent_fork` (`tool-workflow` disabled). | **Batch computation & context savings**: inspecting/transforming >5-10 files, cross-referencing JSONs/logs, bulk regex, or chaining 10-20 tool calls in 1 turn without inflating context. |
| **`team`** | `preset-team` (`Modo Team`) | **9 `agent-team` tools** + `team:policy` + `team:identity` + `workflow` + Web UI panel. | **Modular parallel work**: dividing complex initiatives across `lead` + up to 7 named teammates (`explorer`, `implementer`, `qa-auditor`) with shared CAS task board and mailboxes. |
| **`minimal`** | `preset-minimal` | Persistent PTY shell (`bash-persistent`) + ultra-low prompt footprint. | **Interactive terminal diagnostics**: sustained PTY troubleshooting or network/process debugging. |
| **`creator`** | `preset-cordis` | Standard toolset + `@deepseek-ai/dsh-tool-cordis`. | **ONLY for live Cordis runtime introspection.** Never switch to `creator` just to edit plugin files (use `standard`). |

---

## 2. Strategic Agent Advantage & Multi-Engine Chaining Workflows

Because mode switching costs **0 ms**, does **not** restart the host, and isolates your session from all other open projects, you hold a decisive operational advantage: you can fluidly switch engines between sub-phases of the exact same task instead of brute-forcing everything in a single mode.

### Winning Multi-Engine Patterns

1. **Speed & Context Pattern (`standard -> ptc -> standard`)**:
   - *Scenario*: Auditing 30 files, parsing large test outputs/JSONs, or migrating structured keys across a repo.
   - *Play*: Switch to `ptc` (0 ms), run a single `run_code` JavaScript pipeline in the Node VM that loops over the files/searches internally and returns only the distilled findings, then switch immediately back to `standard` (0 ms) for crisp surgical edits or reporting.
2. **Parallel Squad Pattern (`standard -> team -> standard`)**:
   - *Scenario*: Multi-module implementation, parallel codebase exploration + verification, or non-overlapping refactors across `backend/`, `frontend/`, and `tests/`.
   - *Play*: Switch to `team` (0 ms), create DAG tasks with disjoint `write_scopes` via `team_task_create`, spawn specialized persistent teammates (`explorer`, `implementer`, `qa-auditor`) via `spawn_teammate` (`fresh` or `fork`), coordinate via `send_message` / `wait_agent`, verify diffs, and switch back to `standard` (0 ms) upon completion.
3. **Choosing the Right Multi-Agent Mechanism (`team` vs `workflow` vs `subagent`)**:
   - Use **`team`** (`switch_mode({ mode: "team" })`) when you want **durable teammates** with persistent memory, interactive steering (`send_message`), and a **shared CAS task board** (`blocked_by`, `write_scopes`, Web UI visibility).
   - Use **`workflow`** (`tools.workflow`, available in `standard` and `team`) when you want a **deterministic JS orchestration script** (`parallel`, `pipeline`, `agent(prompt, { provider, model })`) OR whenever you **must pick a specific model** (`deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp` for images).
   - Use **`subagent` / `subagent_fork`** (in `standard` or `ptc`) for a quick, single fire-and-forget subtask using the default model.

---

## 3. Deep Dive: The `team` Engine (Native Agent Teams)

### 3.1 Runtime Configuration (`~/.dsh/profiles/web/cordis.patch.yml`)

When a session enters `preset-team` (`Modo Team`), `@deepseek-ai/dsh-experimental-tool-agent-team` dynamically mounts tools onto that session's container (and its spawned teammates):
- **`@deepseek-ai/dsh-experimental-agent-team`**:
  - `maxMembers`: 8 (1 Lead + up to 7 concurrent teammates)
  - `maxTasks`: 256
  - `maxMessageBytes`: 65536 (64 KB inbox message limit)
  - `disposalTimeoutMs`: 5000 ms
- **`@deepseek-ai/dsh-experimental-tool-agent-team`** *(patched for per-preset gating)*:
  - Checks `ctx.agentPresets.composedPreset(agent.ctx) === "team"` (plus teammates).
  - Unmounts all 9 tools and `team:policy` / `team:identity` immediately when switching away from `team`.
- **`@deepseek-ai/dsh-experimental-client-ui-agent-team`** *(patched for per-preset UI gating)*:
  - Renders the `👥 Equipo de agentes` header button and board modal only when `leadPreset === "team"`.

### 3.2 The 9 Agent Team Tools: Exact Reference

#### Agent Lifecycle & Communication
1. **`spawn_teammate({ name, description, prompt, context })`** *(Lead only)*:
   - Spawns an autonomous durable teammate agent.
   - `name`: Unique lower-kebab-case identifier (e.g. `explorer`, `implementer`, `auditor`).
   - `description`: Concise role summary.
   - `prompt`: Self-contained, explicit initial assignment instructions.
   - `context`: `"fresh"` (clean slate, default) or `"fork"` (inherits parent conversation history).
2. **`send_message({ target, message })`** *(Any member)*:
   - Delivers a typed message directly to `target` (`"lead"` or teammate name).
   - Wakes up an `inactive` member immediately or steers a `running` one at the nearest step boundary. Returns `{ "sent": true }`.
3. **`list_agents({})`** *(Any member)*:
   - Queries the roster of active members, roles, and status (`running`, `inactive`, `provisioning`, `failed`).
   - *Note*: `inactive` indicates turn completion awaiting next inbox message; it does **not** mean the agent failed or was killed.
4. **`wait_agent({ timeout_ms })`** *(Any member, usually Lead)*:
   - Synchronizes and waits for teammate activity or task updates (timeout 10,000ms to 3,600,000ms, default 30,000ms).
   - Returns `noProgress` immediately if no peers are active or provisioning, preventing empty wait loops.
5. **`interrupt_agent({ target })`** *(Lead only)*:
   - Halts a teammate's active turn while preserving its pending inbox.

#### CAS Shared Task Board (`team_task_*`)
6. **`team_task_create({ subject, description, blocked_by, write_scopes })`** *(Any member)*:
   - Creates a work item on the shared team board.
   - `blocked_by`: Array of prerequisite task IDs enforcing DAG dependency ordering.
   - `write_scopes`: Advisory list of workspace directories/files the task touches (e.g. `["src/backend/"]`).
7. **`team_task_list({ status, owner, ready, cursor, limit })`** *(Any member)*:
   - Lists tasks with filters (`status`: `"pending"` | `"in_progress"` | `"completed"`). Returns task IDs, current `ownerName`, and `revision`.
8. **`team_task_get({ task_id })`** *(Any member)*:
   - Retrieves full description, blockers, and latest `revision` for a specific task.
9. **`team_task_update({ task_id, expected_revision, action, ... })`** *(Any member)*:
   - **Atomic Compare-And-Set (CAS)**: `expected_revision` MUST match the board's current revision number to prevent race conditions.
   - `action`: `"claim"`, `"release"`, `"edit"`, `"set_dependencies"`, `"complete"`, `"reopen"`, `"reassign"`, `"delete"`.

### 3.3 Operating Protocol for Teams

1. **Lead Decomposition:** Initiator acts as `lead`, creates disjoint work units via `team_task_create` (`write_scopes` + `blocked_by`).
2. **Specialized Spawning:** Spawns specialized peers (`explorer`, `tester`, `implementer`) using `spawn_teammate`.
3. **Claiming via CAS:** Teammates list/get tasks and claim via `team_task_update({ task_id, expected_revision: N, action: "claim" })`.
4. **Handoffs & Completion:** Teammates complete tasks (`action: "complete"`) and report deliverables via `send_message({ target: "lead", message })`.
5. **Clean Return to Standard:** Once all tasks are complete and verified, the Lead switches back to `standard` in 0 ms:
   `switch_mode({ mode: "standard", reason: "Team orchestration completed, returning to standard development" })`.

---

## 4. Invoking `switch_mode`

```json
switch_mode({
  "mode": "ptc",
  "reason": "Batch-inspecting 25 JSON files via run_code in 1 turn before surgical edits"
})
```

- Returns immediately with `[MODO AISLADO]`: engine switched in memory for this session only, `state.json` untouched, zero restart.
- `creator` automatically maps to the native `cordis` preset.
- If `dsh-supervisor.service` ever restarts the host for maintenance/recovery, it runs `--patch ~/.dsh/modes/standard.yml --no-open` and dispatches `POST /__dsh_fleet/wake` if needed.

---

## 5. Strict Operational Rules & Verification Tools

1. **NEVER run `dsh web` manually from the shell:** Port `3080` is owned 24/7 by `dsh-supervisor.service`. Use `dsh-open` (`/usr/local/bin/dsh-open`) to open the browser UI safely.
2. **NEVER kill `supervisor.mjs`:** Protected by singleton lock `~/.dsh/mode-router/supervisor.pid` and `--no-open` anti-tab-clutter flag.
3. **Per-Session Fleet Telemetry:** Inspect real per-session modes using `dsh-top --once` (parses `agent-preset/selected` from `.zstd` + `session_projcache`) or `curl -s http://127.0.0.1:3080/__dsh_fleet/status`. Do **not** read `state.json` to infer another session's mode.
4. **Post-Upgrade Patch Verification:** After upgrading `@deepseek-ai/dsh`, run `bash mode-router-real/apply-team-isolation-patches.sh` (or `--check` to audit).
