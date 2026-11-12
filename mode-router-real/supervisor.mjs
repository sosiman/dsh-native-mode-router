#!/usr/bin/env node
/**
 * Supervisor de motores de DSH con Auto-Wakeup.
 *
 * Arranca `dsh web` con el patch del motor actual, vigila la petición que deja la
 * herramienta `switch_mode` (~/.dsh/mode-router/request.json) y, cuando llega:
 *
 *   1. escribe el motor pedido en state.json
 *   2. para el proceso dsh (SIGTERM, y SIGKILL si no muere en 12 s)
 *   3. lo relanza con `--patch ~/.dsh/modes/<modo>.yml`
 *   4. espera a que el puerto vuelva a responder (~1.5s)
 *   5. DESPIERTA a la sesión (Auto-Wakeup) inyectando el prompt de reanudación
 *      vía POST /__dsh_fleet/wake para que la inferencia continúe automáticamente.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'

const DSH_BIN = process.env.DSH_BIN ?? 'dsh'
const HOME = process.env.HOME ?? homedir()
const STATE_DIR = join(HOME, '.dsh', 'mode-router')
const REQUEST_FILE = join(STATE_DIR, 'request.json')
const STATE_FILE = join(STATE_DIR, 'state.json')
const LOG_FILE = join(STATE_DIR, 'supervisor.log')
const LOCK_FILE = join(STATE_DIR, 'supervisor.pid')
const MODES_DIR = join(HOME, '.dsh', 'modes')
const MODES = ['minimal', 'standard', 'ptc', 'team', 'creator']

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const dryRun = argv.includes('--dry-run')
const port = Number(flag('--port', '3080'))
let mode = flag('--mode', 'standard')
let child = null
let pendingWake = null
let currentSessionId = null

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  // Si stdout ya va a un fichero (nohup/systemd), escribir tambien en LOG_FILE
  // duplicaba cada linea. Solo se imprime cuando hay terminal.
  if (process.stdout.isTTY) process.stdout.write(line)
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(LOG_FILE, line, { flag: 'a' })
  } catch { /* el log es best-effort */ }
}

/** Un unico supervisor por HOME. Dos compitiendo por request.json producen
 *  reinicios a medias, dobles wakeups y modos que "no cambian". Si el pid del
 *  lockfile sigue vivo, este proceso no arranca; si esta muerto, reclama el lock. */
function claimSingleton() {
  try {
    const other = Number(readFileSync(LOCK_FILE, 'utf8').trim())
    if (other && other !== process.pid) {
      process.kill(other, 0) // lanza si ese pid ya no existe
      return { ok: false, other }
    }
  } catch { /* sin lock o pid muerto: seguimos */ }
  try {
    writeFileSync(LOCK_FILE, String(process.pid))
  } catch (error) {
    log(`aviso: no pude escribir ${LOCK_FILE}: ${String(error)}`)
  }
  process.on('exit', () => {
    try {
      if (Number(readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) rmSync(LOCK_FILE, { force: true })
    } catch { /* best-effort */ }
  })
  return { ok: true }
}

function patchFor(nextMode) {
  return join(MODES_DIR, `${nextMode}.yml`)
}

function start() {
  const patch = patchFor(mode)
  if (!existsSync(patch)) {
    log(`ABORTADO: no existe el patch ${patch}`)
    process.exit(1)
  }
  const args = ['web', '--patch', patch, '--no-open']
  if (dryRun) {
    log(`[dry-run] ${DSH_BIN} ${args.join(' ')}`)
    return
  }
  log(`arrancando motor '${mode}'`)
  child = spawn(DSH_BIN, args, {
    env: { ...process.env, HOME, DSH_HOME: join(HOME, '.dsh') },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  child.on('exit', (code, signal) => {
    log(`dsh terminó (code=${code} signal=${signal})`)
    if (child?.pid === undefined && !stopping) process.exit(code ?? 1)
  })
  writeState()
}

let stopping = false

function writeState() {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ mode, sessionId: currentSessionId, pid: child?.pid ?? null, at: new Date().toISOString() }, null, 2))
  } catch (error) {
    log(`no se pudo escribir state: ${String(error)}`)
  }
}

async function stopChild() {
  if (child === null || child.exitCode !== null) return
  stopping = true
  const pid = child.pid
  log(`parando dsh (pid ${pid})`)
  child.kill('SIGTERM')
  const deadline = Date.now() + 12_000
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
  }
  if (child.exitCode === null) {
    log('no murió con SIGTERM, mando SIGKILL')
    child.kill('SIGKILL')
    await new Promise((r) => setTimeout(r, 500))
  }
  stopping = false
}

function probe() {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 1500 }, (res) => {
      res.resume()
      resolve(res.statusCode !== undefined)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
    req.end()
  })
}

async function waitForPort(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

function wakeAgent(sessionId, targetMode, reason) {
  return new Promise((resolve) => {
    // Breve pausa para que el WebSocket de DSH Web se reenganche
    setTimeout(() => {
      log(`enviando auto-wakeup a sesión ${sessionId} (motor: ${targetMode})...`)
      const payload = JSON.stringify({ sessionId, mode: targetMode, reason })
      const req = request({
        host: '127.0.0.1',
        port,
        path: '/__dsh_fleet/wake',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 8000
      }, (res) => {
        let resp = ''
        res.on('data', chunk => { resp += chunk })
        res.on('end', () => {
          log(`auto-wakeup respuesta (${res.statusCode}): ${resp}`)
          resolve(res.statusCode === 200)
        })
      })
      req.on('error', (err) => {
        log(`auto-wakeup error: ${err.message}`)
        resolve(false)
      })
      req.write(payload)
      req.end()
    }, 1500)
  })
}

async function switchTo(nextMode, reason, sessionId) {
  if (!MODES.includes(nextMode)) {
    log(`ignorado: modo inválido '${nextMode}'`)
    return
  }
  if (nextMode === mode) {
    log(`ignorado: ya estamos en '${nextMode}'`)
    return
  }
  log(`CAMBIO: '${mode}' -> '${nextMode}' (motivo: ${reason ?? 'sin motivo'}, sesión: ${sessionId ?? 'desconocida'})`)
  currentSessionId = sessionId ?? null
  pendingWake = sessionId ? { sessionId, mode: nextMode, reason } : null
  await stopChild()
  mode = nextMode
  start()
  if (dryRun) return
  const up = await waitForPort()
  log(up ? `motor '${mode}' arriba` : `AVISO: el puerto ${port} no respondió a tiempo`)
  
  if (up && pendingWake) {
    const toWake = pendingWake
    pendingWake = null
    await wakeAgent(toWake.sessionId, toWake.mode, toWake.reason)
  }
}

function watchRequests() {
  setInterval(() => {
    if (!existsSync(REQUEST_FILE)) return
    let payload
    try {
      payload = JSON.parse(readFileSync(REQUEST_FILE, 'utf8'))
    } catch {
      log('request.json ilegible, lo descarto')
      rmSync(REQUEST_FILE, { force: true })
      return
    }
    rmSync(REQUEST_FILE, { force: true })
    void switchTo(payload.mode, payload.reason, payload.sessionId)
  }, 500)
}

mkdirSync(STATE_DIR, { recursive: true })
const claim = claimSingleton()
if (!claim.ok) {
  const msg = `ABORTADO: ya hay un supervisor vivo (pid ${claim.other}), no arranco otro`
  log(msg)
  process.stderr.write(msg + "\n")
  process.exit(1)
}
log(`supervisor arriba, motor inicial '${mode}'${dryRun ? ' (dry-run)' : ''} (pid ${process.pid})`)
start()
watchRequests()

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`señal ${signal}: cerrando`)
    void stopChild().then(() => process.exit(0))
  })
}
