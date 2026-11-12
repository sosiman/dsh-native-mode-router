/**
 * dsh-plugin-fleet-monitor — mitad host (cordis).
 *
 * Expone dos rutas propias (prefijo /__, sin token del navegador):
 *
 *   GET  /__dsh_fleet/status           estado del host, del escritorio y de la flota
 *   POST /__dsh_fleet/launch-terminal  abre una terminal con dsh-top en el escritorio
 *
 * El proceso de `dsh web` puede vivir en una sesion de sistema (XDG_SESSION_TYPE=tty)
 * sin DISPLAY. Por eso el entorno grafico no se inventa: se copia del proceso de
 * escritorio real (plasmashell, kwin, nemo, gnome-shell...).
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const name = "fleet-monitor";
const inject = ["webServer", "sessionController"];

const VERSION = "1.2.0";
const HOME = process.env.HOME || homedir();
const DSH_HOME = process.env.DSH_HOME || join(HOME, ".dsh");
const SESSIONS_DIR = join(DSH_HOME, "sessions");
const STATE_FILE = join(DSH_HOME, "mode-router", "state.json");
const PID_FILE = "/tmp/dsh-fleet-monitor.pid";
const TITLE = "DSH Fleet Monitor \u2014 Estado en Vivo";

const MONITOR_CANDIDATES = [
  join(HOME, "dsh-plugins", "dsh-plugin-fleet-monitor", "bin", "dsh-top"),
  "/usr/local/bin/dsh-top",
];

const DESKTOP_PROCESSES = [
  "plasmashell",
  "kwin_wayland",
  "kwin_x11",
  "gnome-shell",
  "cinnamon",
  "xfce4-session",
  "mate-session",
  "nemo",
  "nautilus",
  "dolphin",
  "thunar",
];

const ENV_KEYS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "DESKTOP_SESSION",
];

const TERMINALS = [
  { bin: "gnome-terminal", args: (cmd) => [`--title=${TITLE}`, "--", ...cmd] },
  { bin: "kgx", args: (cmd) => [`--title=${TITLE}`, "--", ...cmd] },
  { bin: "konsole", args: (cmd) => ["-p", `tabtitle=${TITLE}`, "-e", ...cmd] },
  { bin: "xfce4-terminal", args: (cmd) => [`--title=${TITLE}`, "-x", ...cmd] },
  { bin: "mate-terminal", args: (cmd) => [`--title=${TITLE}`, "-x", ...cmd] },
  { bin: "tilix", args: (cmd) => ["-t", TITLE, "-e", ...cmd] },
  { bin: "x-terminal-emulator", args: (cmd) => ["-e", ...cmd] },
  { bin: "xterm", args: (cmd) => ["-T", TITLE, "-e", ...cmd] },
];

const PATH_DIRS = (process.env.PATH || "/usr/local/bin:/usr/bin:/bin").split(":");

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function fileInfo(path) {
  try {
    const st = statSync(path);
    return { path, exists: true, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
  } catch {
    return { path, exists: false };
  }
}

function pathBinary(bin) {
  for (const dir of PATH_DIRS) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      const st = statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {
      /* sigue */
    }
  }
  return undefined;
}

/** Entorno grafico copiado de un proceso de escritorio vivo. */
let desktopCache = { at: 0, value: undefined };

function readProcEnv(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
    const env = {};
    for (const entry of raw.split("\0")) {
      const at = entry.indexOf("=");
      if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
    }
    return env;
  } catch {
    return undefined;
  }
}

function probeDesktop(force = false) {
  const now = Date.now();
  if (!force && desktopCache.value !== undefined && now - desktopCache.at < 20_000) {
    return desktopCache.value;
  }
  let pids = [];
  try {
    pids = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry));
  } catch {
    pids = [];
  }
  const preferred = [];
  const others = [];
  for (const pid of pids) {
    let comm = "";
    try {
      comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    } catch {
      continue;
    }
    if (DESKTOP_PROCESSES.includes(comm)) preferred.push({ pid, comm });
    else if (comm === "google-chrome" || comm === "chrome" || comm === "firefox") others.push({ pid, comm });
  }
  for (const candidate of [...preferred, ...others]) {
    const env = readProcEnv(candidate.pid);
    if (!env) continue;
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) continue;
    const picked = {};
    for (const key of ENV_KEYS) {
      if (env[key]) picked[key] = env[key];
    }
    const value = {
      source: `${candidate.comm}(${candidate.pid})`,
      env: picked,
      xauthorityPresent: Boolean(picked.XAUTHORITY),
      sessionType: picked.XDG_SESSION_TYPE || "unknown",
    };
    desktopCache = { at: now, value };
    return value;
  }
  desktopCache = { at: now, value: undefined };
  return undefined;
}

function launchEnv() {
  const desktop = probeDesktop();
  const env = { ...process.env };
  if (desktop) Object.assign(env, desktop.env);
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) env.DISPLAY = ":0";
  if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `/run/user/${process.getuid?.() ?? 1000}`;
  return { env, desktop };
}

function monitorScript() {
  for (const path of MONITOR_CANDIDATES) {
    const info = fileInfo(path);
    if (info.exists) return info;
  }
  return { path: MONITOR_CANDIDATES[MONITOR_CANDIDATES.length - 1], exists: false };
}

function runningMonitors() {
  let pid = 0;
  try {
    pid = Number(readFileSync(PID_FILE, "utf8").trim());
  } catch {
    pid = 0;
  }
  if (!pid) return [];
  try {
    process.kill(pid, 0);
    return [pid];
  } catch {
    return [];
  }
}

/** Resumen barato de la flota: solo mtime, sin descomprimir cabeceras. */
function fleetSummary() {
  const now = Date.now();
  let total = 0;
  let live = 0;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) walk(path, depth + 1);
      else if (entry.isFile() && /^session\.v\d+.*\.zstd$/.test(entry.name)) {
        total += 1;
        try {
          if (now - statSync(path).mtimeMs < 90_000) live += 1;
        } catch {
          /* la sesion desaparecio mientras leiamos */
        }
      }
    }
  };
  walk(SESSIONS_DIR, 0);
  return { sessions: total, live };
}

function engineState() {
  const state = readJsonFile(STATE_FILE, {});
  let alive = false;
  const pid = Number(state.pid);
  if (pid > 0) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  return {
    mode: String(state.mode || "standard"),
    pid: pid > 0 ? pid : null,
    alive,
    at: state.at ?? null,
  };
}

function status() {
  const script = monitorScript();
  const desktop = probeDesktop();
  return {
    ok: true,
    version: VERSION,
    host: name,
    uptimeSec: Math.round(process.uptime()),
    engine: engineState(),
    fleet: fleetSummary(),
    monitorScript: script,
    monitors: runningMonitors(),
    desktop: desktop
      ? {
          source: desktop.source,
          sessionType: desktop.sessionType,
          display: desktop.env.DISPLAY ?? null,
          wayland: desktop.env.WAYLAND_DISPLAY ?? null,
          xauthority: desktop.xauthorityPresent,
        }
      : null,
    terminals: TERMINALS.map((t) => t.bin).filter((bin) => pathBinary(bin) !== undefined),
  };
}

function trySpawn(bin, args, env) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn(bin, args, { env, detached: true, stdio: "ignore" });
    } catch (error) {
      resolve({ ok: false, error: String(error) });
      return;
    }
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: String(error) });
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ ok: true, pid: child.pid });
    });
  });
}

async function launchTerminal() {
  const script = monitorScript();
  if (!script.exists) {
    return { status: 500, body: { ok: false, version: VERSION, error: `No encuentro el monitor en ${script.path}` } };
  }
  const { env, desktop } = launchEnv();
  const command = [script.path];
  const errors = [];
  for (const terminal of TERMINALS) {
    const bin = pathBinary(terminal.bin);
    if (!bin) continue;
    const result = await trySpawn(bin, terminal.args(command), env);
    if (result.ok) {
      return {
        status: 200,
        body: {
          ok: true,
          version: VERSION,
          terminal: terminal.bin,
          pid: result.pid,
          script: script.path,
          desktop: desktop
            ? { source: desktop.source, display: desktop.env.DISPLAY ?? null, wayland: desktop.env.WAYLAND_DISPLAY ?? null }
            : { source: "fallback", display: env.DISPLAY ?? null, wayland: env.WAYLAND_DISPLAY ?? null },
        },
      };
    }
    errors.push(`${terminal.bin}: ${result.error}`);
  }
  return {
    status: 500,
    body: { ok: false, version: VERSION, error: "No hay ninguna terminal grafica disponible", tried: errors },
  };
}

function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/__dsh_fleet/status",
    handler: (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET" });
        res.end();
        return;
      }
      try {
        sendJson(res, 200, status());
      } catch (error) {
        sendJson(res, 500, { ok: false, version: VERSION, error: String(error) });
      }
    },
  }), "fleet-monitor: ruta status");


  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/__dsh_fleet/wake",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" });
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body || "{}");
          const sessionId = data.sessionId;
          const mode = data.mode || "standard";
          const reason = data.reason || "Continuar con la tarea planificada";

          if (!sessionId) {
            sendJson(res, 400, { ok: false, error: "Missing sessionId" });
            return;
          }

          const promptText = `[SISTEMA]: Motor conmutado con éxito a ${mode}. La sesión se ha reanudado en caliente. Continúa de inmediato con tu tarea: ${reason}`;
          const request = {
            sessionId,
            content: [{ type: "text", text: promptText }],
            requestId: `wake-${Date.now()}`
          };
          const source = { kind: "user" };

          const controller = ctx.sessionController || (ctx.get ? ctx.get("sessionController") : null);
          if (controller && controller.commands) {
            await controller.commands.prompt(request, source);
            console.log(`[fleet-monitor] Sesión ${sessionId} despertada con éxito en motor ${mode}`);
            sendJson(res, 200, { ok: true, awakened: sessionId, mode });
          } else {
            console.error("[fleet-monitor] sessionController no disponible en ctx");
            sendJson(res, 500, { ok: false, error: "sessionController not available" });
          }
        } catch (err) {
          console.error("[fleet-monitor] Error en /__dsh_fleet/wake:", err);
          sendJson(res, 500, { ok: false, error: String(err) });
        }
      });
    }
  }), "fleet-monitor: ruta wake");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/__dsh_fleet/launch-terminal",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" });
        res.end();
        return;
      }
      try {
        const result = await launchTerminal();
        sendJson(res, result.status, result.body);
      } catch (error) {
        sendJson(res, 500, { ok: false, version: VERSION, error: String(error) });
      }
    },
  }), "fleet-monitor: ruta launch-terminal");

  ctx.effect(() => {
    desktopCache = { at: 0, value: undefined };
    return () => {
      desktopCache = { at: 0, value: undefined };
    };
  }, "fleet-monitor: cache del escritorio");
}

export { name, inject, apply };
