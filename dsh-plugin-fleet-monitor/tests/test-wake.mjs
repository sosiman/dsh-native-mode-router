/**
 * Prueba de la ruta /__dsh_fleet/wake sin cargar dsh web.
 *
 * Simula el ctx de cordis (webServer, effect, sessionController) y captura el
 * prompt que se inyecta al despertar la sesión: comprueba que lleva el motor.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { apply } from "../lib/index.js";

const routes = new Map();
const prompts = [];

const ctx = {
  effect(fn) {
    fn();
    return () => {};
  },
  sessionController: {
    commands: {
      async prompt(request, source) {
        prompts.push({ request, source });
      },
    },
  },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  },
};

apply(ctx);
assert.ok(routes.has("/__dsh_fleet/wake"), "ruta wake registrada");
console.log("OK  la ruta /__dsh_fleet/wake está registrada");

function postWake(body) {
  const handler = routes.get("/__dsh_fleet/wake");
  const req = new EventEmitter();
  req.method = "POST";
  const chunks = [];
  const res = {
    statusCode: 0,
    writeHead(status) {
      this.statusCode = status;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      resolveWake({ status: this.statusCode, json });
    },
  };
  let resolveWake;
  const done = new Promise((resolve) => {
    resolveWake = resolve;
  });
  handler(req, res);
  req.emit("data", JSON.stringify(body));
  req.emit("end");
  return done;
}

const result = await postWake({
  sessionId: "session-abc",
  mode: "ptc",
  reason: "Prueba de despertar",
});
assert.equal(result.status, 200, JSON.stringify(result.json));
assert.equal(result.json.ok, true);
assert.equal(result.json.awakened, "session-abc");
assert.equal(result.json.mode, "ptc");
assert.equal(prompts.length, 1, "se inyectó un prompt");
const text = prompts[0].request.content[0].text;
assert.match(text, /Motor conmutado con éxito a ptc\./, "el prompt lleva el motor real");
assert.match(text, /Prueba de despertar/, "el prompt lleva el motivo");
console.log("OK  el prompt inyectado es:", JSON.stringify(text));
console.log("OK  el modo viaja en el texto y en la respuesta JSON");

const missing = await postWake({ mode: "ptc" });
assert.equal(missing.status, 400);
console.log("OK  sin sessionId responde 400");

const wrongMethod = routes.get("/__dsh_fleet/wake");
const req = new EventEmitter();
req.method = "GET";
let status = 0;
wrongMethod(req, {
  writeHead(code) {
    status = code;
  },
  end() {},
});
assert.equal(status, 405);
console.log("OK  GET en wake devuelve 405");

console.log("\nwake: todas las pruebas pasan");
