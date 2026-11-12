---
name: dsh-native-modes
description: "Autonomous hot-switching across DeepSeek Harness native engines (Standard, PTC, Team, Minimal, Creator) using switch_mode with fleet concurrency protection, full Agent Team orchestration (9 tools), and Auto-Wakeup."
version: 2.2.0
author: LOKTAR Multi-Agent Architecture
platforms: [linux]
metadata:
  tags: [dsh, switch_mode, ptc, team, minimal, standard, creator, auto-wakeup, fleet-guard, agent-team, multi-agent]
---

# DeepSeek Harness Native Engines & Autonomous Mode Switching

This skill is the authoritative, production-grade guide for AI agents operating inside DeepSeek Harness (DSH).

---

## 1. Autonomous Engine Selection & Architecture

> [!NOTE]
> **DSH Web runs on `127.0.0.1:3080` under systemd (`dsh-supervisor.service`).**
> All autonomous agents possess full authority to switch execution engines via `switch_mode({ mode, reason })` according to the technical profile of the incoming task, **without requesting manual permission from the user**.

### The 5 Native Engines: Decision Matrix

| Engine | Cordis Patch File | Primary Purpose | When An Agent Must Autonomously Switch |
|---|---|---|---|
| **`standard`** | `~/.dsh/modes/standard.yml` | General software engineering, targeted file edits, git workflows. | **UNIVERSAL SAFE MODE**. Use for 95% of tasks: writing code, reading files, refactoring, unit tests, and routine shell commands. Always switch back to `standard` upon completing team or batch tasks. |
| **`ptc`** | `~/.dsh/modes/ptc.yml` | Programmatic Tool Calling (`run_code` in Node.js VM). | **Mandatory for loops and batch computation**: iterating >10 files or JSON objects, bulk data transformations, mass regex, or chaining 20 operations in 1 single turn without token exhaustion. |
| **`team`** | `~/.dsh/modes/team.yml` | Native Experimental Agent Teams (`agent-team`). | **Mandatory for modular multi-agent projects**: complex initiatives divided into parallel streams (e.g. Lead + Explorer, Implementer, QA/Auditor), shared CAS task board, and typed mailboxes. |
| **`minimal`** | `~/.dsh/modes/minimal.yml` | Interactive persistent PTY bash shell (`@deepseek-ai/dsh-tool-bash-persistent`). | **Mandatory for interactive shell diagnostics**: network monitoring, long-running interactive terminal processes, or commands requiring immediate TTFT <0.5s. |
| **`creator`** | `~/.dsh/modes/creator.yml` | Cordis internal runtime introspection. | **ONLY for debugging live Cordis containers.** NEVER switch to creator just to edit plugin source files (use `standard`). |

---

## 2. Multi-Project Safety & Fleet Concurrency Guard

> [!IMPORTANT]
> **`dsh web` is a single host process running on `127.0.0.1:3080` for ALL workspaces and projects (PENDRIVE, IA LOKTAR, devwebs, etc.).**
> Mode switching is fully automated, non-blocking, and coordinated across the fleet:
> - **Non-Blocking Execution**: `switch_mode` writes requests to `~/.dsh/mode-router/request.json` without restrictive blocking or artificial denials.
> - **Fast In-Memory vs. Overlay Reload**: In-memory Cordis preset recomposition is isolated and immediate; for engines requiring deep plugins (`team`, `ptc`), the supervisor reloads DSH in ~1.2s applying the engine overlay (`--patch ~/.dsh/modes/<mode>.yml --no-open`).
> - **Guaranteed Auto-Wakeup**: Upon reloading, the supervisor sends `POST /__dsh_fleet/wake` targeting your session ID, reviving your turn with `[SISTEMA]: Motor conmutado con éxito a '<mode>'` so execution continues without interruption.
> - **Autonomous Operation**: Agents possess full authority to switch engines whenever task demands require specialized capabilities (e.g., `team` for agent teams, `ptc` for iterative batch computation) without requiring manual permission or stalling in standard mode.

---

## 3. Deep Dive: The `team` Engine (Native Agent Teams)

The `team` engine replaces legacy single-threaded subagents with native, coordinated Agent Teams.

### 3.1 Architecture & Runtime Configuration (`~/.dsh/modes/team.yml`)

When switched to `team`, DSH activates the official experimental agent-team stack:
- **`@deepseek-ai/dsh-experimental-agent-team`**:
  - `maxMembers`: 8 (1 Lead + up to 7 concurrent teammates)
  - `maxTasks`: 256
  - `maxMessageBytes`: 65536 (64 KB inbox message limit)
  - `disposalTimeoutMs`: 5000 ms
- **`@deepseek-ai/dsh-experimental-tool-agent-team`**:
  - `freshProvider`: `spawn`
  - `forkProvider`: `fork`
- **`@deepseek-ai/dsh-experimental-client-ui-agent-team`**:
  - Web UI team board, teammate statuses, and live log view.
- **Legacy subagents disabled**: `tool-subagent`, `tool-subagent-fork`, and `tool-subagent-control` are explicitly disabled to prevent API conflicts.

### 3.2 The 9 Agent Team Tools: Exact Reference

In `team` mode, agents gain access to 9 dedicated coordination tools:

#### Agent Lifecycle & Communication
1. **`spawn_teammate({ name, description, prompt, context })`** *(Lead only)*:
   - Spawns an autonomous teammate agent in the active session.
   - `name`: Unique lower-kebab-case identifier (e.g. `explorer`, `implementer`, `auditor`).
   - `description`: Concise role summary.
   - `prompt`: Self-contained, explicit initial assignment instructions.
   - `context`: `"fresh"` (clean slate, default) or `"fork"` (inherits parent conversation history).
2. **`send_message({ target, message })`** *(Any member)*:
   - Delivers a typed message directly to `target` (`"lead"` or teammate name).
   - Wakes up an `inactive` member immediately or queues for the next step boundary if executing.
   - Returns: `{ "sent": true }`.
3. **`list_agents({})`** *(Any member)*:
   - Queries the roster of active members, roles, and status (`running`, `inactive`, `provisioning`, `failed`).
   - *Note*: `inactive` indicates turn completion awaiting next inbox message; it does NOT mean the agent was killed.
4. **`wait_agent({ timeout_ms })`** *(Any member, usually Lead)*:
   - Synchronizes and waits for teammate activity or task updates (timeout 10,000ms to 3,600,000ms, default 30,000ms).
   - Returns `noProgress` immediately if no peers are active or provisioning, preventing deadlocks.
5. **`interrupt_agent({ target })`** *(Lead only)*:
   - Halts a teammate's active turn while preserving its queue and state.

#### CAS Shared Task Board (`team_task_*`)
6. **`team_task_create({ subject, description, blocked_by, write_scopes })`** *(Any member)*:
   - Creates a work item on the shared team board.
   - `subject`: Task title / concise summary.
   - `description`: Detailed specifications and verification criteria.
   - `blocked_by`: Array of prerequisite task IDs enforcing DAG dependency ordering.
   - `write_scopes`: Advisory list of workspace directories the task touches (e.g. `["src/backend/"]`).
7. **`team_task_list({ status, owner, ready, cursor, limit })`** *(Any member)*:
   - Lists tasks with filters (`status`: `"pending"` | `"in_progress"` | `"completed"`).
   - Returns task items with `task_id`, current `owner`, and current `revision`.
8. **`team_task_get({ task_id })`** *(Any member)*:
   - Retrieves full description, blockers, and latest `revision` for a specific task.
9. **`team_task_update({ task_id, expected_revision, action, ... })`** *(Any member)*:
   - **Atomic Compare-And-Set (CAS)**: `expected_revision` MUST match the board's current revision number to prevent race conditions.
   - `action`: `"claim"` (assigns owner), `"release"`, `"edit"`, `"set_dependencies"`, `"complete"`, `"reopen"`, `"reassign"`, `"delete"`.

### 3.3 Operating Protocol for Teams

1. **Lead Decomposition:** Initiator acts as `lead`. Decomposes the overarching objective into distinct, isolated work units via `team_task_create` with disjoint `write_scopes`.
2. **Specialized Spawning:** Spawns specialized peers (e.g. `explorer`, `tester`, `implementer`) using `spawn_teammate`.
3. **Claiming via CAS:** Teammates inspect `team_task_list` and claim tasks using `team_task_update({ task_id, expected_revision: N, action: "claim" })`.
4. **Handoffs & Completion:** Teammates report deliverables via `team_task_update({ task_id, expected_revision: N, action: "complete" })` and notify `target: "lead"` via `send_message`.
5. **Session Teardown:** Once all tasks are completed and verified, the Lead **MUST** switch back to `standard` mode:
   `switch_mode({ mode: "standard", reason: "Team orchestration completed, returning to standard development" })`.

---

## 4. How `switch_mode` Works & Auto-Wakeup

```json
switch_mode({
  "mode": "team",
  "reason": "Decomposing feature into 2 parallel worker agents (backend, frontend)"
})
```

1. **Dual-Path Dispatch:**
   - **Fast Path:** In-memory preset recomposition if compatible.
   - **Overlay Path:** Writes `{ mode, reason, sessionId, at, pid }` to `~/.dsh/mode-router/request.json`.
2. **Atomic Reload:** Supervisor detects the request, gracefully restarts DSH with `--patch ~/.dsh/modes/<mode>.yml --no-open` in ~1.2s.
3. **Auto-Wakeup:** Supervisor issues `POST /__dsh_fleet/wake`. The session controller injects your continuation prompt (`wakeup: true`) and your turn resumes automatically in the new engine.

---

## 5. Strict Operational Rules for Autonomous Agents

1. **NEVER run `dsh web` manually from the shell:** The server runs 24/7 as `systemctl --user status dsh-supervisor.service`. Running `dsh web` manually crashes with `listen EADDRINUSE: 127.0.0.1:3080`.
2. **NEVER kill `supervisor.mjs`:** The supervisor manages hot-reloads and turn resumption under a singleton PID lock (`~/.dsh/mode-router/supervisor.pid`).
3. **Browser Tab Protection:** The supervisor automatically passes `--no-open` to `dsh web`. Engine reloads will **never** open duplicate browser tabs on the user's desktop.
4. **Fleet Telemetry:** Real-time metrics for all active sessions can be inspected via `/usr/local/bin/dsh-top` or `curl -s http://127.0.0.1:3080/__dsh_fleet/status`.
