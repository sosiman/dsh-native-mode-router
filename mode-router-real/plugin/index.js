import { mkdirSync, writeFileSync, renameSync, readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'switch-mode-tool'
export const inject = ['tools', 'agentPresets', 'agents']

const MODES = ['minimal', 'standard', 'ptc', 'team', 'creator']
const VALID_AGENT_PRESETS = ['standard', 'ptc', 'minimal', 'cordis']
const REQUEST_DIR = join(homedir(), '.dsh', 'mode-router')
const REQUEST_FILE = join(REQUEST_DIR, 'request.json')
const STATE_FILE = join(REQUEST_DIR, 'state.json')
const SESSIONS_DIR = join(homedir(), '.dsh', 'sessions')

function readCurrentState() {
  try {
    if (!existsSync(STATE_FILE)) return null
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function resolveActiveSessionId(rawAgentId) {
  if (rawAgentId) {
    return String(rawAgentId).startsWith('session-') ? String(rawAgentId) : `session-${rawAgentId}`
  }
  try {
    if (!existsSync(SESSIONS_DIR)) return null
    const workspaces = readdirSync(SESSIONS_DIR, { withFileTypes: true })
    let latestTime = 0
    let latestId = null
    for (const ws of workspaces) {
      if (!ws.isDirectory() || !ws.name.startsWith('--')) continue
      const wsPath = join(SESSIONS_DIR, ws.name)
      const sessions = readdirSync(wsPath, { withFileTypes: true })
      for (const s of sessions) {
        if (!s.isDirectory()) continue
        const zstdV4 = join(wsPath, s.name, 'session.v4.jsonl.zstd')
        const zstdV3 = join(wsPath, s.name, 'session.v3.jsonl.zstd')
        const zstd = existsSync(zstdV4) ? zstdV4 : (existsSync(zstdV3) ? zstdV3 : null)
        if (zstd) {
          const mtime = statSync(zstd).mtimeMs
          if (mtime > latestTime) {
            latestTime = mtime
            latestId = s.name
          }
        }
      }
    }
    return latestId
  } catch {
    return null
  }
}

const PARAMETERS = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: MODES,
      description: 'Motor destino: ptc (bucles/batch TS), team (multiagente), minimal (shell PTY rápido), creator (plugins Cordis), standard (desarrollo general).'
    },
    reason: {
      type: 'string',
      description: 'Motivo técnico del cambio y tarea que continuarás.'
    },
  },
  required: ['mode', 'reason'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['accepted'] },
    mode: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['status', 'mode', 'message'],
  additionalProperties: false,
}

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'switch_mode',
    description:
      'Conmuta en caliente el motor de la sesión con Auto-Wakeup.\n' +
      '• standard: Desarrollo general, lectura/edición de ficheros, bash y git.\n' +
      '• ptc: Bucles masivos con run_code en Node.js VM sin quemar tokens.\n' +
      '• minimal: Terminal de latencia mínima para diagnósticos rápidos.\n' +
      '• creator: Entorno de introspección para depurar plugins Cordis.\n' +
      '• team: Orquestación multiagente experimental.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String(value.message) }],
    },
    async execute(args, exec) {
      const mode = args?.mode
      const reason = args?.reason
      if (!MODES.includes(mode)) throw new Error(`switch_mode: modo inválido ${JSON.stringify(mode)}`)
      if (typeof reason !== 'string' || reason.trim() === '') {
        throw new Error('switch_mode: reason es obligatorio')
      }

      const initiator = ctx.agents?.currentInitiator?.() || exec?.agent || null
      const rawAgentId = initiator?.id || exec?.agent?.id || exec?.agent?.session?.id || null
      const sessionId = resolveActiveSessionId(rawAgentId)
      const targetPreset = mode === 'creator' ? 'cordis' : mode
      const safeAgentPreset = VALID_AGENT_PRESETS.includes(targetPreset) ? targetPreset : 'standard'
      const currentState = readCurrentState()
      const session = initiator?.session || exec?.agent?.session

      const presets = ctx.agentPresets || (ctx.get ? ctx.get('agentPresets') : null)
      const agentCtx = initiator?.ctx || exec?.agent?.ctx
      let presetRecorded = false
      const recordSafePreset = () => {
        if (presetRecorded || !session?.append) return
        try {
          session.append('agent-preset/selected', { agentPreset: safeAgentPreset })
          presetRecorded = true
        } catch { /* el registro es best-effort */ }
      }

      // 1. Modos con preset nativo DSH (standard, ptc, minimal, cordis)
      if (VALID_AGENT_PRESETS.includes(targetPreset)) {
        const needsSupervisorResetFromTeam = mode === 'standard' && currentState?.mode === 'team'
        if (presets && agentCtx) {
          try {
            await presets.recompose(agentCtx, safeAgentPreset)
            recordSafePreset()
            if (!needsSupervisorResetFromTeam) {
              return {
                status: 'accepted',
                mode,
                message:
                  `[MODO AISLADO]: Esta sesión ha cambiado a '${mode}' en memoria de forma instantánea. ` +
                  `El servidor dsh web NO se ha reiniciado y todos tus demás proyectos permanecen 100% intactos en sus propios motores. ` +
                  `Motivo: ${reason.trim()}`
              }
            }
          } catch {
            // Si recompose falla, continúa al supervisor sin bloquear
          }
        }
      } else if (mode === 'team') {
        // `team` es un overlay de supervisor, NUNCA un agentPreset de DSH.
        // Recompone/registra la sesión en 'standard' para que reanude siempre sin errores.
        if (presets && agentCtx) {
          try {
            await presets.recompose(agentCtx, 'standard')
          } catch { /* best-effort antes del overlay o reutilización */ }
        }
        recordSafePreset()
        if (currentState?.mode === 'team' && currentState?.pid === process.pid) {
          return {
            status: 'accepted',
            mode: 'team',
            message:
              `[MODO TEAM ACTIVO]: El motor 'team' ya está cargado en este proceso y esta sesión ` +
              `ha quedado lista con sus herramientas base estándar y agent-team sin reiniciar el servidor. ` +
              `Motivo: ${reason.trim()}`
          }
        }
      }

      // 2. Conmutación vía supervisor (para team y restauración a standard desde team, o fallback)
      // Registra SIEMPRE safeAgentPreset (nunca 'team') para proteger la reanudación en frío.
      recordSafePreset()
      mkdirSync(REQUEST_DIR, { recursive: true })
      const request = {
        mode,
        reason: reason.trim(),
        sessionId: sessionId || 'desconocida',
        at: new Date().toISOString(),
        pid: process.pid,
      }
      const tmpFile = join(REQUEST_DIR, `request.${process.pid}.${Date.now()}.tmp`)
      writeFileSync(tmpFile, JSON.stringify(request, null, 2), 'utf8')
      renameSync(tmpFile, REQUEST_FILE)
      return {
        status: 'accepted',
        mode,
        message:
          `Cambio a '${mode}' iniciado. El supervisor reconfigurará el motor (~1.5s) y ` +
          `DESPERTARÁ automáticamente esta sesión. Motivo: ${request.reason}`,
      }
    },
  }), 'switch-mode-tool: switch_mode')
}
