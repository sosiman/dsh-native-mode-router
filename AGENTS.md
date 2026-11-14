# Agent Directives — Per-Session In-Memory Engine Switching & Fleet Orchestration (v3.0)

This workspace equips agents with `switch_mode`, enabling **0 ms per-session in-memory switching** across all 5 DeepSeek Harness engines (`standard`, `ptc`, `team`, `minimal`, `creator`) without restarting `dsh web` or affecting other open sessions.

## Autonomous Engine Selection & Per-Session In-Memory Isolation (v3.0 — 0 ms)

> [!NOTE]
> **DSH Web corre en `127.0.0.1:3080` bajo systemd (`dsh-supervisor.service`) con aislamiento 100% por sesión.**
> Todos los agentes tienen plena autoridad autónoma para conmutar de motor mediante `switch_mode({ mode, reason })` según las exigencias de la tarea, **sin pedir permiso previo al usuario** y con **0 ms de latencia y 0 impacto en otras sesiones**.

### Arquitectura v3.0: Recompuesto en Memoria por Sesión (Sin Reinicios)
- Los 5 motores (**`standard`**, **`ptc`**, **`team`**, **`minimal`**, **`creator`**) están registrados como presets nativos de `@deepseek-ai/dsh-agent-preset` (`preset-standard`, `preset-ptc`, `preset-team` en `~/.dsh/profiles/web/cordis.patch.yml`, `preset-minimal` y `preset-cordis`).
- Al invocar `switch_mode({ mode, reason })`, el plugin (`dsh-plugin-switch-mode`) ejecuta `await presets.recompose(agentCtx, targetPreset)` y registra el evento `agent-preset/selected` **instantáneamente en memoria (`[MODO AISLADO]`, 0 ms)** solo para tu sesión.
- **Aislamiento Total Entre Proyectos y Sesiones**:
  - Cambiar a `team`, `ptc`, `standard`, `minimal` o `creator` (en cualquier dirección, incluido `team -> ptc` o `team -> standard`) **NUNCA reinicia `dsh web`**.
  - Tu cambio de motor **NUNCA modifica el modo de otros proyectos o sesiones abiertas** (cada sesión conserva su propio preset independiente).
  - El proceso host permanece estable con `--patch ~/.dsh/modes/standard.yml --no-open` y `~/.dsh/mode-router/state.json` en `"standard"`.
- **Ciclo de Vida Dinámico de `team` (`Modo Team`)**:
  - Al entrar en `team`, se montan dinámicamente en TU sesión (y sus teammates) las 9 herramientas `agent-team` + `team:policy` + `team:identity`, el selector superior izquierdo cambia a **`Modo Team`**, aparece el botón **`👥 Equipo de agentes`** y se omiten `subagent`/`subagent_fork` (conservando `workflow`).
  - Al salir de `team` hacia `ptc`, `standard`, `minimal` o `creator`, las 9 herramientas `agent-team` y `team:policy`/`team:identity` se desmontan al instante del contenedor de la sesión (no quedan accesibles ni desde `run_code`) y el botón **`👥 Equipo de agentes`** desaparece de inmediato.
- **Respaldo de Alta Disponibilidad (`dsh-supervisor.service`)**: El demonio systemd supervisa el puerto `3080` 24/7 con `--no-open` y `POST /__dsh_fleet/wake` como mecanismo de recuperación automática ante caídas del proceso host.

### Decision Matrix: Cuándo y Por Qué Conmutar Autónomamente

| Motor | Preset Nativo | Herramientas Clave | Cuándo Conmutar Autónomamente (0 ms) |
|---|---|---|---|
| **`standard`** | `preset-standard` | `read`/`edit`/`write`, `bash`, `grep`/`glob`, `subagent`, `subagent_fork`, `workflow`, `tool-web`. | **Modo base por defecto**. Ideal para edición quirúrgica, lectura puntual, Git, tests y entregas finales. Al terminar fases en `ptc`, `team` o `minimal`, regresa aquí en 0 ms. |
| **`ptc`** | `preset-ptc` | **`run_code`** (VM Node.js programática envolviendo las tools + `subagent`). | **Bucles, lotes y ahorro masivo de contexto**: inspeccionar/filtrar >5-10 archivos, cruzar JSONs/logs, refactorizaciones por regex en lote o encadenar 10-20 llamadas en 1 solo turno. |
| **`team`** | `preset-team` (`Modo Team`) | **9 tools `agent-team`** + `team:policy` + `workflow` + UI `👥 Equipo de agentes`. | **Proyectos paralelos y modulares**: dividir objetivos grandes entre `lead` y hasta 7 teammates persistentes (`explorer`, `implementer`, `qa-auditor`) con pizarra atómica CAS y buzones. |
| **`minimal`** | `preset-minimal` | Shell PTY persistente (`bash-persistent`) y mínima sobrecarga. | **Terminal interactiva y diagnóstico rápido**: pruebas continuas de red/servicios o sesiones PTY persistentes con mínimo contexto. |
| **`creator`** | `preset-cordis` | Añade `@deepseek-ai/dsh-tool-cordis` al stack estándar. | **ÚNICAMENTE para introspección en vivo del runtime Cordis/DSH**. NUNCA cambiar a `creator` solo para editar código de plugins (hazlo en `standard`). |

---

## Tu Ventaja Estratégica como Agente Autónomo (Superpoderes Multi-Motor 0 ms)

Como el cambio de motor tarda **0 ms en memoria**, preserva **100% tu conversación actual** y **no molesta a ninguna otra sesión**, tienes una ventaja táctica decisiva frente a trabajar encerrado en un único modo:

1. **Combo Relámpago `standard ↔ ptc` (10x velocidad, mínima quema de tokens)**:
   - ¿Acabas de recibir un repo grande o debes revisar 25 archivos / logs / JSONs antes de decidir qué editar? En lugar de gastar 15 turnos de `read`/`grep`, haz `switch_mode({ mode: "ptc", reason: "Análisis y filtrado en lote con run_code" })`, ejecuta un script Node en `run_code` que procese todo en 1 turno devolviendo solo los hallazgos exactos, y vuelve al instante con `switch_mode({ mode: "standard", reason: "Edición quirúrgica final" })`.
2. **Despliegue de Escuadrón `standard ↔ team` (Paralelismo real con pizarra CAS)**:
   - ¿La tarea tiene 2+ módulos independientes (p. ej. backend + frontend + auditoría QA) o exige investigación profunda en paralelo sin ensuciar tu propio contexto? Conmuta a `team` en 0 ms, crea tareas con `write_scopes` disjuntos (`team_task_create`), lanza especialistas (`spawn_teammate` con `fresh` o `fork`), coordínalos en tiempo real (`send_message`, `wait_agent`) y regresa a `standard` en 0 ms al cerrar.
3. **Elección Precisa entre los 3 Sistemas Multiagente (`team` vs `workflow` vs `subagent`)**:
   - **`team` (`switch_mode({ mode: "team" })`)**: Equipo persistente con identidad y memoria entre turnos (`send_message` bidireccional), dependencias DAG (`blocked_by`) y panel visual en la Web UI. Ideal para ingeniería colaborativa iterativa.
   - **`workflow` (`tools.workflow`, disponible en `standard` y `team`)**: Script JS determinista (`parallel`, `pipeline`, `agent(prompt, opts)`). **Obligatorio cuando necesites elegir el modelo exacto por hijo** (p. ej. flash para bulk, pro para razonamiento, vision para imágenes).
   - **`subagent` / `subagent_fork` (en `standard` y `ptc`)**: Delegación rápida de 1 subtarea puntual sin necesitar modelo específico ni tablero compartido.
4. **Conmutación Transparente y Sin Dudas**:
   - Invoca `switch_mode({ mode, reason })` proactivamente cada vez que el perfil de la subfase cambie, y continúa inmediatamente con tu plan sin pedir permiso intermedio al usuario.

---

## Agent Teams Engine (`team` Mode) & Catálogo de 9 Herramientas Nativas

Al conmutar tu sesión a `team` mediante `switch_mode({ mode: 'team', reason: '...' })`, esa sesión activa el stack oficial `@deepseek-ai/dsh-experimental-agent-team` y `@deepseek-ai/dsh-experimental-tool-agent-team` (`maxMembers: 8` = Lead + hasta 7 compañeros persistentes, `maxTasks: 256`, `maxMessageBytes: 65536`) además de mantener `workflow`.

### Roles e Identidades
- **Team Lead (`lead`)**: Agente principal iniciador. Es el único que puede invocar `spawn_teammate` e `interrupt_agent`.
- **Teammates (`<name>`)**: Agentes persistentes identificados por su nombre único en `kebab-case` (ej. `explorer`, `implementer`, `qa-auditor`).
- **Direccionamiento**: Utilizar siempre el nombre del rol o agente (`target: "lead"` o `target: "implementer"`), NUNCA IDs de sesión opacos.

### Referencia de las 9 Herramientas de Agent-Team:
1. **`spawn_teammate({ name, description, prompt, context })`** *(Solo Lead)*: Genera un compañero de equipo persistente (`context`: `"fresh"` por defecto o `"fork"`).
2. **`send_message({ target, message })`** *(Cualquier miembro)*: Envía un mensaje directo a `target` (`"lead"` o nombre del compañero); despierta a un miembro `inactive`. Retorna `{ "sent": true }`.
3. **`list_agents({})`** *(Cualquier miembro)*: Lista miembros, roles y estado (`running`, `inactive`, `provisioning`, `failed`).
4. **`wait_agent({ timeout_ms })`** *(Cualquier miembro)*: Espera cambios en teammates o tablero (10000ms–3600000ms, defecto 30000ms); devuelve `noProgress` al instante si nadie está activo.
5. **`interrupt_agent({ target })`** *(Solo Lead)*: Interrumpe el turno actual de un compañero conservando su buzón.
6. **`team_task_create({ subject, description, blocked_by, write_scopes })`** *(Any member)*: Crea tarea en pizarra CAS con dependencias DAG y `write_scopes`.
7. **`team_task_list({ status, owner, ready, cursor, limit })`** *(Any member)*: Filtra tareas y consulta `ownerName` y `revision`.
8. **`team_task_get({ task_id })`** *(Any member)*: Obtiene detalle y `revision` actual.
9. **`team_task_update({ task_id, expected_revision, action, ... })`** *(Any member)*: Actualización atómica CAS (`claim`, `release`, `edit`, `set_dependencies`, `complete`, `reopen`, `reassign`, `delete`).

### Protocolo de Coordinación Multiagente:
1. **Ámbitos de Escritura Disjuntos**: Asignar `write_scopes` disjuntos en las tareas compartidas.
2. **Recuperación ante Colisiones**: Si una edición devuelve `FS_STALE_VERSION`, releer y reaplicar.
3. **Cierre de Misión**: Al finalizar la fase coordinada y verificada, el Lead DEBE conmutar su sesión de vuelta a `standard`:
   `switch_mode({ mode: "standard", reason: "Fase multiagente completada con éxito. Reanudando modo estándar." })`.

---

## Reglas Operativas Estrictas para Agentes Autónomos:
1. **NUNCA ejecutar `dsh web` a mano desde la terminal:** El servidor está gestionado 24/7 por systemd (`systemctl --user status dsh-supervisor.service`). Ejecutarlo a mano provocará error fatal `listen EADDRINUSE: 127.0.0.1:3080`. Para abrir la interfaz en el navegador usa `dsh-open`.
2. **NUNCA matar el proceso de `supervisor.mjs`:** Mantiene el cerrojo singleton en `~/.dsh/mode-router/supervisor.pid`.
3. **Protección Anti-Pestañas (`--no-open`):** Evita abrir pestañas duplicadas en reinicios del servicio.
4. **Telemetría Real de Flota:** Verifica el modo efectivo **por sesión** con `dsh-top --once` o `curl -s http://127.0.0.1:3080/__dsh_fleet/status` (no uses `state.json` para inferir el modo de una sesión concreta).
5. **Post-Upgrade Patch Check:** Tras actualizar `@deepseek-ai/dsh`, ejecutar `bash mode-router-real/apply-team-isolation-patches.sh` (`--check` para auditar).
