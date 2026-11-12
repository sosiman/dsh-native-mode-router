# Agent Directives — Autonomous Engine Selection & Fleet Orchestration

This workspace provides agents with runtime access to `switch_mode`, enabling autonomous switching across DeepSeek Harness engines (`standard`, `ptc`, `team`, `minimal`, `creator`) with guaranteed in-flight session resumption (Auto-Wakeup).

## Autonomous Engine Selection & Hot-Switching (`switch_mode`)

> [!NOTE]
> **DSH Web runs on `127.0.0.1:3080` under systemd (`dsh-supervisor.service`).**
> Todos los agentes cuentan con plena autoridad autónoma para conmutar de motor de ejecución mediante `switch_mode({ mode, reason })` según la naturaleza de la tarea técnica que enfrenten, **sin necesidad de pedir confirmación ni permiso previo al usuario**.

### Decision Matrix: Cuándo y Por Qué Conmutar de Motor

| Motor | Propósito Primario | Cuándo Conmutar Autónomamente |
|---|---|---|
| **`standard`** | Desarrollo general, edición precisa de archivos y Git. | **Modo por defecto para el 95% de tareas**: análisis, lectura/escritura de código, tests unitarios y bash habitual. Al terminar tareas en otros motores, conmutar de vuelta a `standard`. |
| **`ptc`** | Programmatic Tool Calling (`run_code` en Node.js VM). | **Bucles masivos y computación en lote**: iterar >10 archivos o JSONs, transformaciones por lotes, mass regex o encadenar 20 operaciones en un solo turno sin agotar la ventana de contexto. |
| **`team`** | Orquestación multiagente nativa (`agent-team`). | **Proyectos modulares y divididos**: tareas complejas que se benefician de división de trabajo paralela (Lead + hasta 8 teammates: Explorer, Implementer, QA/Auditor), pizarra CAS y buzones tipados. |
| **`minimal`** | Shell interactivo PTY persistente. | **Diagnóstico rápido y terminal interactivo**: pruebas de red en tiempo real, depuración interactiva de procesos o herramientas con TTFT ultra-bajo (<0.5s). |
| **`creator`** | Introspección y depuración de contenedores Cordis. | **ÚNICAMENTE para depurar el runtime interno de Cordis/DSH**. NUNCA usar para editar código fuente de plugins o scripts (hacerlo en `standard`). |

### Ciclo de Vida de Conmutación & Auto-Wakeup
1. Llamar a `switch_mode({ mode: "<target>", reason: "<explicación técnica de la conmutación>" })`.
2. El sistema aplica la vía más rápida:
   - **Vía Rápida en Memoria**: Si los presets lo permiten, conmuta de inmediato sin reiniciar.
   - **Vía Overlay del Supervisor**: Para motores con plugins profundos (`team`, `ptc`), escribe `~/.dsh/mode-router/request.json`. El supervisor reinicia DSH con `--patch ~/.dsh/modes/<mode>.yml --no-open` en ~1.2s.
3. **Auto-Wakeup Garantizado**: Tras el reinicio, el supervisor ejecuta `POST /__dsh_fleet/wake` inyectando tu turno de reanudación:
   `[SISTEMA]: Motor conmutado con éxito a '<mode>'. Continúa de inmediato con tu tarea...`
4. **Continuación Inmediata**: Continúa tu trabajo en el nuevo motor sin interrupción.

### Concurrencia de Flota & Arquitectura No Bloqueante (Fleet Safety Guard)
- `dsh web` atiende todos los espacios de trabajo y proyectos en el puerto `3080`.
- **Conmutación Sin Bloqueos**: Las peticiones de conmutación de motor escriben la solicitud en `~/.dsh/mode-router/request.json` sin bloqueos restrictivos ni denegaciones de seguridad.
- **Recarga Ultrarrápida del Supervisor**: El supervisor (`dsh-supervisor.service`) detecta la solicitud y aplica el parche del motor (`--patch ~/.dsh/modes/<mode>.yml --no-open`) reiniciando DSH en apenas ~1.2 segundos.
- **Reactivación Automática (Auto-Wakeup)**: Tras aplicar la recarga, el supervisor despierta de inmediato la sesión solicitante mediante `POST /__dsh_fleet/wake`, inyectando el turno de reanudación sin requerir intervención del usuario ni reinicios manuales.
- **Uso Autónomo Proactivo**: Los agentes disponen de total libertad para conmutar al motor óptimo en cualquier proyecto según la complejidad de la tarea (ej. conmutar a `team` para multiagente o a `ptc` para cómputo masivo), con la garantía de que el Auto-Wakeup reactivará la ejecución de forma transparente.

---

## Agent Teams Engine (`team` Mode) & Catálogo de 9 Herramientas Nativas

Al conmutar a `team` mediante `switch_mode({ mode: 'team', reason: '...' })`, la sesión desactiva las herramientas legacy de subagentes y activa `@deepseek-ai/dsh-experimental-agent-team` y `@deepseek-ai/dsh-experimental-tool-agent-team` (Lead + hasta 8 compañeros de equipo con pizarra CAS y buzones tipados).

### Roles e Identidades
- **Team Lead (`lead`)**: Agente principal iniciador. Es el único que puede invocar `spawn_teammate` e `interrupt_agent`.
- **Teammates (`<name>`)**: Agentes persistentes identificados por su nombre único en `kebab-case` (ej. `explorer`, `implementer`, `qa-auditor`).
- **Direccionamiento**: Utilizar siempre el nombre del rol o agente (`target: "lead"` o `target: "implementer"`), NUNCA IDs de sesión opacos.

### Referencia de las 9 Herramientas de Agent-Team:
1. **`spawn_teammate({ name, description, prompt, context })`** *(Solo Lead)*:
   - Genera un compañero de equipo persistente.
   - `name`: Identificador único en kebab-case.
   - `description`: Responsabilidad delegada concisa.
   - `prompt`: Instrucción técnica completa, autosuficiente y delimitada.
   - `context`: `"fresh"` (contexto limpio, recomendado por defecto) o `"fork"` (hereda el historial previo del Lead).
2. **`send_message({ target, message })`** *(Cualquier miembro)*:
   - Envía un mensaje directo a `target` (`"lead"` o nombre del compañero).
   - Despierta a un agente inactivo o entra en la cola para su siguiente paso. Retorna `{ "sent": true }`.
3. **`list_agents({})`** *(Cualquier miembro)*:
   - Devuelve la lista de miembros, sus roles y estado (`running`, `inactive`, `provisioning`, `failed`).
   - *Nota*: `inactive` significa que el turno del agente terminó y espera un mensaje; NO significa que haya fallado o sido destruido.
4. **`wait_agent({ timeout_ms })`** *(Cualquier miembro, principalmente Lead)*:
   - Espera eventos o actividad de los compañeros (tiempo límite: 10000ms a 3600000ms, por defecto 30000ms).
   - Retorna de inmediato `noProgress` si ningún compañero está activo o aprovisionándose, evitando bucles de espera vacíos.
5. **`interrupt_agent({ target })`** *(Solo Lead)*:
   - Interrumpe de forma limpia el turno en curso de un compañero manteniendo intacto su buzón de entrada.
6. **`team_task_create({ subject, description, blocked_by, write_scopes })`** *(Cualquier miembro)*:
   - Publica una tarea en la pizarra compartida del equipo.
   - `blocked_by`: IDs de tareas previas necesarias (grafo DAG de dependencias).
   - `write_scopes`: Rutas del workspace que la tarea tocará (ej. `["src/backend/"]`) para evitar colisiones.
7. **`team_task_list({ status, owner, ready, cursor, limit })`** *(Cualquier miembro)*:
   - Consulta las tareas filtrando por `status` (`"pending"` | `"in_progress"` | `"completed"`). Retorna IDs, propietarios y la versión (`revision`).
8. **`team_task_get({ task_id })`** *(Cualquier miembro)*:
   - Obtiene el detalle completo de la tarea y su número de `revision` actual antes de actualizarla.
9. **`team_task_update({ task_id, expected_revision, action, ... })`** *(Cualquier miembro)*:
   - **Actualización Atómica Compare-And-Set (CAS)**: `expected_revision` DEBE coincidir con la revisión actual para evitar condiciones de carrera entre compañeros concurrentes.
   - `action`: `"claim"`, `"release"`, `"edit"`, `"set_dependencies"`, `"complete"`, `"reopen"`, `"reassign"`, `"delete"`.

### Protocolo de Coordinación Multiagente:
1. **Ámbitos de Escritura Disjuntos**: Todos los miembros comparten el mismo filesystem. Es imperativo asignar tareas con `write_scopes` disjuntos para prevenir conflictos.
2. **Recuperación ante Colisiones**: Si una edición devuelve `FS_STALE_VERSION`, releer el archivo actualizado y reaplicar el cambio.
3. **Cierre de Misión**: Al finalizar la tarea coordinada y verificada, el Lead DEBE conmutar el motor de vuelta a `standard`:
   `switch_mode({ mode: "standard", reason: "Fase multiagente completada con éxito. Reanudando modo estándar." })`.

---

## Reglas Operativas Estrictas para Agentes Autónomos:
1. **NUNCA ejecutar `dsh web` a mano desde la terminal:** El servidor está gestionado 24/7 por systemd (`systemctl --user status dsh-supervisor.service`). Ejecutarlo a mano provocará error fatal `listen EADDRINUSE: 127.0.0.1:3080`.
2. **NUNCA matar el proceso de `supervisor.mjs`:** El supervisor mantiene el cerrojo singleton en `~/.dsh/mode-router/supervisor.pid`.
3. **Protección Anti-Pestañas (`--no-open`):** El supervisor arranca DSH siempre con `--no-open`, garantizando que ningún cambio de motor abra pestañas duplicadas en el escritorio.
4. **Telemetría de Flota:** Puedes verificar el estado en vivo de la flota en cualquier momento con `/usr/local/bin/dsh-top --once` o `curl -s http://127.0.0.1:3080/__dsh_fleet/status`.

---

## Plugins, Patches & Customizaciones
- **Sidebar Copy Button:** Nativo en DSH 0.2+ (`copyText=row.cwd`). No requiere parches legacy.
- **DSH Update Cleanup:** Los enlaces simbólicos en `~/.dsh/profiles/node_modules/@deepseek-ai` pueden romperse al actualizar DSH. Limpiar con:
  `for l in ~/.dsh/profiles/node_modules/@deepseek-ai/*; do [ -e "$l" ] || rm -f "$l"; done`
- **Plugin `dsh-archived-cleanup` (v1.2.0):** Settings > Plugins > "Archived". Elimina sesiones archivadas **y sesiones vacías** (creadas sin mensajes) sin dejar estado huérfano. Ubicación activa: `~/.dsh/profiles/web/node_modules/dsh-archived-cleanup-2`. Helper CLI: `/usr/local/bin/dsh-empty`.
- **Plugin `dsh-plugin-fleet-monitor` (v1.2.0):** Settings > Plugins > "DSH Fleet Monitor". Muestra telemetría en tiempo real y ofrece el botón "Abrir Terminal en Vivo" lanzando `/usr/local/bin/dsh-top` en `DISPLAY=:0`.
- **Plugin Builder Skill:** `~/.dsh/skills/dsh-plugin-builder/SKILL.md` (Comillar siempre cadenas con `: ` en frontmatter YAML).
