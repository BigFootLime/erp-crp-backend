import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileRouteAdapter, prepare, promote, promoteTwoHosts, rollback, sha256 } from "../blue-green-runtime-operator.mjs";

async function candidate({ healthy = true, websocket = true } = {}) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === "/health/ready") return res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ background_runtime: { role: "api", ready: healthy } }));
    if (req.url === "/api/v1/auth/me") return res.writeHead(401).end();
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket) => websocket ? socket.end(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")}\r\n\r\n`) : socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n"));
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => server.close(resolve)); } };
}
function plan(baseUrl, baseline = "old-route") { return { schema: "cerp-blue-green-v1", waitMs: 30_000, capacity: { vpsFreeGiB: 20 }, hosts: { vps: { endpoint: "vps" }, hyper: { endpoint: "hyper" } }, legacyWorkerDrain: { required: true }, baseline: { routeFileSha256: sha256(baseline) }, routes: { http: { host: "cerp", target: "old" }, websocket: { host: "cerp", target: "old" } }, candidate: { id: "new", baseUrl, version: "v1", role: "api", imageDigest: `sha256:${"a".repeat(64)}`, publicLabels: false } }; }

test("promotes only a healthy HTTP and WebSocket candidate and rolls back routes", async () => { const c = await candidate(); const p = plan(c.baseUrl); const prepared = await prepare(p, "old-route"); const promoted = await promote(p, "old-route", prepared, async (x) => x); assert.equal(promoted.target, "new"); assert.deepEqual(rollback(promoted).target, "old"); await c.close(); });
test("refuses a sick candidate and preserves the old route", async () => { const c = await candidate({ healthy: false }); const p = plan(c.baseUrl); const prepared = await prepare(p, "old-route"); await assert.rejects(promote(p, "old-route", prepared, async (x) => x)); await c.close(); });
test("refuses a baseline change before any flip", async () => { const c = await candidate(); const p = plan(c.baseUrl); await assert.rejects(prepare(p, "changed")); await c.close(); });
test("refuses a candidate whose WebSocket handshake fails", async () => { const c = await candidate({ websocket: false }); const p = plan(c.baseUrl); const prepared = await prepare(p, "old-route"); await assert.rejects(promote(p, "old-route", prepared, async (x) => x)); await c.close(); });
test("compensates to the old route when an atomic route write fails", async () => { const c = await candidate(); const p = plan(c.baseUrl); const prepared = await prepare(p, "old-route"); const state = await promote(p, "old-route", prepared, async () => { throw new Error("write failed"); }); assert.deepEqual(state, { ...prepared, phase: "prepared", target: "old", compensation: "restored-prior-route", error: "Error" }); await c.close(); });
test("uses real two-host route files and restores VPS if HYPER promotion fails", async () => { const c = await candidate(); try { const root = await mkdtemp(join(tmpdir(), "cerp-bg-")); const vpsPath = join(root, "vps.json"); const hyperPath = join(root, "hyper.json"); await writeFile(vpsPath, "old-vps"); await writeFile(hyperPath, "old-hyper"); const vps = new FileRouteAdapter(vpsPath); const hyper = new FileRouteAdapter(hyperPath); const p = plan(c.baseUrl); const failingHyper = { read: hyper.read.bind(hyper), replace: async () => { throw new Error("hyper unavailable"); } }; const result = await promoteTwoHosts(p, { vps, hyper: failingHyper }); assert.deepEqual(result, { phase: "blocked", reason: "HYPER_PROMOTION_FAILED", compensation: "VPS_RESTORED", error: "Error" }); assert.equal(await readFile(vpsPath, "utf8"), "old-vps"); assert.equal(await readFile(hyperPath, "utf8"), "old-hyper"); } finally { await c.close(); } });
