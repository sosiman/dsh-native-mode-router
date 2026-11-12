import { mkdirSync, writeFileSync, renameSync, readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'switch-mode-tool'
export const inject = ['tools', 'agentPresets', 'agents']

const MODES = ['minimal', 'standard', 'ptc', 'team', 'creator']
const REQUEST_DIR = join(homedir(), '.dsh', 'mode-router')
const REQUEST_FILE = join(REQUEST_DIR, 'request.json')
const SESSIONS_DIR = join(homedir(), '.dsh', 'sessions')

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

      // 1. Intento de conmutación en memoria si el agente y el preset lo permiten
      const presets = ctx.agentPresets || (ctx.get ? ctx.get('agentPresets') : null)
      const agentCtx = initiator?.ctx || exec?.agent?.ctx
      if (presets && agentCtx && ['standard', 'ptc', 'minimal', 'cordis', 'team'].includes(targetPreset)) {
        try {
          await presets.recompose(agentCtx, targetPreset)
          const session = initiator?.session || exec?.agent?.session
          if (session?.append) {
            session.append('agent-preset/selected', { agentPreset: targetPreset })
          }
          return {
            status: 'accepted',
            mode,
            message:
              `[MODO AISLADO]: Esta sesión ha cambiado a '${mode}' en memoria de forma instantánea. ` +
              `El servidor dsh web NO se ha reiniciado y todos tus demás proyectos permanecen 100% intactos en sus propios motores. ` +
              `Motivo: ${reason.trim()}`
          }
        } catch {
          // Si recompose falla, continúa al supervisor sin bloquear
        }
      }

      // 2. Conmutación vía supervisor (para team y modos con reinicio)
      // Sin bloqueo restrictivo: escribe la petición y el supervisor reinicia + Auto-Wakeup
      // Se registra la selección TAMBIÉN aquí: si no, el monitor (que lee el log de la
      // sesión) seguiría mostrando el preset anterior tras un cambio global.
      const switchSession = initiator?.session || exec?.agent?.session
      if (switchSession?.append) {
        try {
          switchSession.append('agent-preset/selected', { agentPreset: targetPreset })
        } catch { /* el registro es best-effort */ }
      }
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
