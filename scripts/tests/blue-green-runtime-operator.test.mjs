import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApacheRouteAdapter, TraefikFileRouteAdapter, promoteTwoHosts } from "../blue-green-runtime-operator.mjs";

const traefik = (name) => "http:\n  routers:\n    api:\n      rule: PathPrefix(\"/api\")\n      service: " + name + "\n    ws:\n      rule: PathPrefix(\"/socket.io\")\n      service: " + name + "\n  services:\n    old: {}\n    green: {}\n";
const apache = (url) => "ProxyPass /api/ " + url + "/api/\nProxyPassReverse /api/ " + url + "/api/\nProxyPass /socket.io/ " + url + "/socket.io/\nProxyPassReverse /socket.io/ " + url + "/socket.io/\n";
const makePlan = (baseUrl) => ({ schema: "cerp-blue-green-v1", waitMs: 5000, capacity: { vpsFreeGiB: 20 }, hosts: { vps: { endpoint: "vps" }, hyper: { endpoint: "hyper" } }, legacyWorkerDrain: { required: true }, routes: { http: { host: "erp", target: "old" }, websocket: { host: "erp", target: "old" } }, candidate: { id: "green", baseUrl, role: "api", imageDigest: "sha256:" + "a".repeat(64), publicLabels: false, routes: { vps: "green", hyper: { http: "http://127.0.0.1:8082", websocket: "http://127.0.0.1:8082" } } } });
async function backend(identity) {
  const open = new Set(), server = http.createServer((req, res) => {
    if (req.url === "/health/ready") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ background_runtime: { role: "api", ready: true } }));
    if (req.url === "/api/v1/auth/me") return res.writeHead(401).end();
    if (req.url === "/identity") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ identity }));
    res.writeHead(404).end();
  });
  server.on("connection", (socket) => { open.add(socket); socket.on("close", () => open.delete(socket)); });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64"), message = Buffer.from(identity);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    setTimeout(() => socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message])), 10);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: "http://127.0.0.1:" + server.address().port, close: async () => { for (const socket of open) socket.destroy(); await new Promise((resolve) => server.close(resolve)); } };
}
async function frontDoor(path, adapter, targets) {
  const target = async () => adapter.targets(await readFile(path, "utf8")).http;
  const sockets = new Set();
  const server = http.createServer(async (req, res) => { const upstream = await fetch(targets[await target()].baseUrl + req.url); res.writeHead(upstream.status, Object.fromEntries(upstream.headers)); res.end(await upstream.text()); });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", async (req, client) => { const upstreamUrl = new URL(targets[await target()].baseUrl), upstream = net.connect(+upstreamUrl.port, upstreamUrl.hostname, () => { upstream.write("GET " + req.url + " HTTP/1.1\r\nHost: " + upstreamUrl.host + "\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: " + req.headers["sec-websocket-key"] + "\r\nSec-WebSocket-Version: 13\r\n\r\n"); client.pipe(upstream).pipe(client); }); upstream.on("error", () => client.destroy()); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: "http://127.0.0.1:" + server.address().port, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); } };
}
async function prove(baseUrl, identity) {
  assert.deepEqual(await (await fetch(baseUrl + "/identity")).json(), { identity });
  const got = await new Promise((resolve, reject) => { const ws = new WebSocket((baseUrl + "/socket.io/?EIO=4&transport=websocket").replace("http:", "ws:")); ws.addEventListener("message", (event) => { ws.close(); resolve(event.data); }, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  assert.equal(got, identity);
}
test("concrete Traefik route file makes HTTP and WebSocket move old to new to old", async () => {
  const old = await backend("old"), green = await backend("green"), root = await mkdtemp(join(tmpdir(), "cerp-bg-")), path = join(root, "dynamic.yml");
  await writeFile(path, traefik("old")); const adapter = new TraefikFileRouteAdapter(path, { httpRouter: "api", websocketRouter: "ws" }), proxy = await frontDoor(path, adapter, { old, green });
  try { await prove(proxy.baseUrl, "old"); let before = await adapter.read(); await adapter.replace(before.hash, adapter.plan(before.text, "green")); await prove(proxy.baseUrl, "green"); before = await adapter.read(); await adapter.replace(before.hash, adapter.plan(before.text, "old")); await prove(proxy.baseUrl, "old"); } finally { await proxy.close(); await old.close(); await green.close(); }
});
test("failed HYPER switch CAS-restores VPS and proves old HTTP and WebSocket identity", async () => {
  const old = await backend("old"), green = await backend("green"), root = await mkdtemp(join(tmpdir(), "cerp-bg-")), vpsPath = join(root, "dynamic.yml"), hyperPath = join(root, "cerp-local.conf");
  await writeFile(vpsPath, traefik("old")); await writeFile(hyperPath, apache("http://127.0.0.1:8080"));
  const vps = new TraefikFileRouteAdapter(vpsPath, { httpRouter: "api", websocketRouter: "ws" }), proxy = await frontDoor(vpsPath, vps, { old, green });
  vps.verify = async (target) => prove(proxy.baseUrl, target);
  const rawHyper = new ApacheRouteAdapter(hyperPath); const hyper = { read: rawHyper.read.bind(rawHyper), plan: rawHyper.plan.bind(rawHyper), targets: rawHyper.targets.bind(rawHyper), verify: async () => {}, replace: async () => { throw new Error("HYPER unavailable"); } };
  try { const result = await promoteTwoHosts(makePlan(green.baseUrl), { vps, hyper }); assert.equal(result.compensation, "VPS_RESTORED"); assert.equal(await readFile(vpsPath, "utf8"), traefik("old")); await prove(proxy.baseUrl, "old"); } finally { await proxy.close(); await old.close(); await green.close(); }
});
test("unrestorable VPS reports COMPENSATION_FAILED", async () => {
  const green = await backend("green"), root = await mkdtemp(join(tmpdir(), "cerp-bg-")), vpsPath = join(root, "dynamic.yml"), hyperPath = join(root, "cerp-local.conf");
  await writeFile(vpsPath, traefik("old")); await writeFile(hyperPath, apache("http://127.0.0.1:8080"));
  const raw = new TraefikFileRouteAdapter(vpsPath, { httpRouter: "api", websocketRouter: "ws" }); let writes = 0;
  const vps = { read: raw.read.bind(raw), plan: raw.plan.bind(raw), targets: raw.targets.bind(raw), verify: async () => {}, replace: async (...args) => { writes += 1; if (writes > 1) throw new Error("restore unavailable"); return raw.replace(...args); } };
  const h = new ApacheRouteAdapter(hyperPath), hyper = { read: h.read.bind(h), plan: h.plan.bind(h), targets: h.targets.bind(h), verify: async () => {}, replace: async () => { throw new Error("HYPER unavailable"); } };
  try { await assert.rejects(promoteTwoHosts(makePlan(green.baseUrl), { vps, hyper }), /COMPENSATION_FAILED/); } finally { await green.close(); }
});
