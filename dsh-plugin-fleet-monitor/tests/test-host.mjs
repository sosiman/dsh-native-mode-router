/**
 * Prueba de la mitad host sin cargar dsh web.
 *
 * Simula el ctx de cordis (webServer.register + effect), captura los handlers y
 * los invoca con req/res falsos. La prueba de lanzamiento abre una terminal REAL
 * en el escritorio (eso es justo lo que queremos comprobar).
 */
import assert from "node:assert/strict";
import { apply, name, inject } from "../lib/index.js";

const routes = new Map();
const disposers = [];

const ctx = {
  effect(fn, label) {
    const dispose = fn();
    if (typeof dispose === "function") disposers.push(dispose);
    return () => {};
  },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  },
};

apply(ctx);

assert.equal(name, "fleet-monitor");
assert.ok(inject.includes("webServer"));
assert.ok(routes.has("/__dsh_fleet/status"), "ruta status registrada");
assert.ok(routes.has("/__dsh_fleet/launch-terminal"), "ruta launch registrada");
console.log("OK  el plugin registra las dos rutas");

function call(path, method) {
  const handler = routes.get(path);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(status, headers = {}) {
        this.statusCode = status;
        this.headers = headers;
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: this.statusCode, headers: this.headers, json, text });
      },
    };
    Promise.resolve(handler({ method, url: path, headers: {} }, res)).catch(reject);
  });
}

const status = await call("/__dsh_fleet/status", "GET");
assert.equal(status.status, 200);
assert.equal(status.json.engine.mode.length > 0, true);
assert.equal(status.json.version, "1.2.0");
assert.equal(status.json.ok, true);
assert.ok(status.json.fleet.sessions > 0, "cuenta sesiones");
assert.equal(status.json.monitorScript.exists, true, "encuentra dsh-top");
assert.ok(status.json.terminals.includes("gnome-terminal"), "detecta gnome-terminal");
console.log("OK  /status:", JSON.stringify({
  version: status.json.version,
  engine: status.json.engine,
  fleet: status.json.fleet,
  desktop: status.json.desktop,
  terminals: status.json.terminals,
  monitor: status.json.monitorScript.path,
}));

const wrong = await call("/__dsh_fleet/launch-terminal", "GET");
assert.equal(wrong.status, 405);
assert.equal(wrong.headers.allow, "POST");
console.log("OK  GET en launch-terminal devuelve 405");

const launched = await call("/__dsh_fleet/launch-terminal", "POST");
assert.equal(launched.status, 200, JSON.stringify(launched.json));
assert.equal(launched.json.ok, true);
assert.ok(launched.json.terminal, "usa una terminal real");
console.log("OK  POST lanza:", JSON.stringify(launched.json));

console.log("\nhost: todas las pruebas pasan");
