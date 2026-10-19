import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApacheRouteAdapter, RemoteRouteAdapter, TraefikFileRouteAdapter, promoteTwoHosts, sha256 } from "../blue-green-runtime-operator.mjs";

const traefik = (name) => "http:\n  routers:\n    api:\n      rule: PathPrefix(\"/api\")\n      service: " + name + "\n    ws:\n      rule: PathPrefix(\"/socket.io\")\n      service: " + name + "\n  services:\n    old: {}\n    green: {}\n";
const apache = (url) => "ProxyPass /api/ " + url + "/api/\nProxyPassReverse /api/ " + url + "/api/\nProxyPass /socket.io/ " + url + "/socket.io/\nProxyPassReverse /socket.io/ " + url + "/socket.io/\n";
const VERSION = "b".repeat(40);
const makePlan = (baseUrl, vps = traefik("old"), hyper = apache("http://127.0.0.1:8080")) => ({ schema: "cerp-blue-green-v1", waitMs: 5000, capacity: { vpsFreeGiB: 20 }, hosts: { vps: { endpoint: "vps" }, hyper: { endpoint: "hyper" } }, baseline: { hosts: { vps: { sha256: sha256(vps) }, hyper: { sha256: sha256(hyper) } } }, legacyWorkerDrain: { required: true }, routes: { http: { host: "erp", target: "old" }, websocket: { host: "erp", target: "old" } }, candidate: { id: "green", baseUrl, version: VERSION, role: "api", imageDigest: "sha256:" + "a".repeat(64), publicLabels: false, routes: { vps: "green", hyper: { http: "http://127.0.0.1:8082", websocket: "http://127.0.0.1:8082" } } } });
const fixture = (name) => readFile(new URL(`./fixtures/blue-green-runtime/${name}`, import.meta.url), "utf8");
async function backend(identity) {
  const open = new Set(), server = http.createServer((req, res) => {
    if (req.url === "/health/ready") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version: VERSION, background_runtime: { role: "api", ready: true } }));
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
test("sanitized live provider fixtures retain unrelated Traefik and Apache GED/test mappings", async () => {
  const [vpsText, hyperText] = await Promise.all([fixture("vps-cerp-web-same-origin-routing.sanitized.yaml"), fixture("hyper-cerp-local.sanitized.conf")]);
  const vps = new TraefikFileRouteAdapter("/data/coolify/proxy/dynamic/cerp-web-same-origin-routing.yaml", { httpRouter: "cerp-web-api", websocketRouter: "cerp-web-socket" });
  const hyper = new ApacheRouteAdapter("/etc/apache2/sites-enabled/cerp-local.conf");
  assert.deepEqual(vps.targets(vpsText), { http: "https-0-rcccokw0wgcw0ck44g0wk0ck@docker", websocket: "https-0-rcccokw0wgcw0ck44g0wk0ck@docker" });
  const vpsPlanned = vps.plan(vpsText, "cerp-api-candidate@file");
  assert.match(vpsPlanned, /cerp-web-ui@docker/);
  const target = { http: "http://127.0.0.1:8086/api/", websocket: "ws://127.0.0.1:8086/socket.io/" };
  const hyperPlanned = hyper.plan(hyperText, target);
  assert.deepEqual(hyper.targets(hyperPlanned), target);
  for (const retained of ["http://127.0.0.1:8082/api/", "http://127.0.0.1:8084/api/", "ws://127.0.0.1:8082/socket.io/", "ws://127.0.0.1:8084/socket.io/", "retry=0"]) assert.match(hyperPlanned, new RegExp(retained.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
});
test("remote adapter requires lock, hash CAS, and confirmed reload verification", async () => {
  const text = await fixture("vps-cerp-web-same-origin-routing.sanitized.yaml"); let stored = text, lock = false;
  const transport = {
    acquireRouteLock: async () => { assert.equal(lock, false); lock = true; return "lease"; },
    releaseRouteLock: async ({ token }) => { assert.equal(token, "lease"); lock = false; return { released: true }; },
    readRoute: async () => ({ text: stored, sha256: sha256(stored) }),
    compareAndSwapRoute: async ({ expectedHash, text: next, sha256: nextHash }) => { assert.equal(sha256(stored), expectedHash); stored = next; return { applied: true, sha256: nextHash }; },
    reloadAndVerifyRoute: async ({ target }) => ({ reloaded: true, providerReadable: true, verified: target === "cerp-api-candidate@file" }),
  };
  const adapter = new RemoteRouteAdapter({ endpoint: "vps", path: "/data/coolify/proxy/dynamic/cerp-web-same-origin-routing.yaml", format: new TraefikFileRouteAdapter("/unused", { httpRouter: "cerp-web-api", websocketRouter: "cerp-web-socket" }), transport });
  const release = await adapter.acquireLock(); const baseline = await adapter.read(); await adapter.replace(baseline.sha256, adapter.plan(baseline.text, "cerp-api-candidate@file")); await adapter.verify("cerp-api-candidate@file"); await release(); assert.equal(lock, false);
});
test("route replacement retains the original file mode", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cerp-bg-")), path = join(root, "dynamic.yml"), adapter = new TraefikFileRouteAdapter(path, { httpRouter: "api", websocketRouter: "ws" });
  await writeFile(path, traefik("old")); await chmod(path, 0o640); const before = await adapter.read(); await adapter.replace(before.hash, adapter.plan(before.text, "green"));
  assert.equal((await stat(path)).mode & 0o777, 0o640);
});
test("failed HYPER switch CAS-restores VPS and proves old HTTP and WebSocket identity", async () => {
  const old = await backend("old"), green = await backend("green"), root = await mkdtemp(join(tmpdir(), "cerp-bg-")), vpsPath = join(root, "dynamic.yml"), hyperPath = join(root, "cerp-local.conf");
  await writeFile(vpsPath, traefik("old")); await writeFile(hyperPath, apache("http://127.0.0.1:8080"));
  const vps = new TraefikFileRouteAdapter(vpsPath, { httpRouter: "api", websocketRouter: "ws" }), proxy = await frontDoor(vpsPath, vps, { old, green });
  vps.verify = async (target) => prove(proxy.baseUrl, target);
  const rawHyper = new ApacheRouteAdapter(hyperPath); const hyper = { path: hyperPath, read: rawHyper.read.bind(rawHyper), plan: rawHyper.plan.bind(rawHyper), targets: rawHyper.targets.bind(rawHyper), verify: async () => {}, replace: async () => { throw new Error("HYPER unavailable"); } };
  try { const result = await promoteTwoHosts(makePlan(green.baseUrl), { vps, hyper }); assert.equal(result.compensation, "BOTH_HOSTS_RESTORED"); assert.equal(await readFile(vpsPath, "utf8"), traefik("old")); await prove(proxy.baseUrl, "old"); } finally { await proxy.close(); await old.close(); await green.close(); }
});
test("unrestorable VPS reports COMPENSATION_FAILED", async () => {
  const green = await backend("green"), root = await mkdtemp(join(tmpdir(), "cerp-bg-")), vpsPath = join(root, "dynamic.yml"), hyperPath = join(root, "cerp-local.conf");
  await writeFile(vpsPath, traefik("old")); await writeFile(hyperPath, apache("http://127.0.0.1:8080"));
  const raw = new TraefikFileRouteAdapter(vpsPath, { httpRouter: "api", websocketRouter: "ws" }); let writes = 0;
  const vps = { path: vpsPath, read: raw.read.bind(raw), plan: raw.plan.bind(raw), targets: raw.targets.bind(raw), verify: async () => {}, replace: async (...args) => { writes += 1; if (writes > 1) throw new Error("restore unavailable"); return raw.replace(...args); } };
  const h = new ApacheRouteAdapter(hyperPath), hyper = { path: hyperPath, read: h.read.bind(h), plan: h.plan.bind(h), targets: h.targets.bind(h), verify: async () => {}, replace: async () => { throw new Error("HYPER unavailable"); } };
  try { await assert.rejects(promoteTwoHosts(makePlan(green.baseUrl), { vps, hyper }), /COMPENSATION_FAILED/); } finally { await green.close(); }
});
test("HYPER write then verification failure restores both concrete files", async () => {
  const green = await backend("green"), root = await mkdtemp(join(tmpdir(), "cerp-bg-")), vpsPath = join(root, "dynamic.yml"), hyperPath = join(root, "cerp-local.conf");
  await writeFile(vpsPath, traefik("old")); await writeFile(hyperPath, apache("http://127.0.0.1:8080"));
  const vps = new TraefikFileRouteAdapter(vpsPath, { httpRouter: "api", websocketRouter: "ws" }); vps.verify = async () => {};
  const raw = new ApacheRouteAdapter(hyperPath); let failVerify = true; const hyper = { path: hyperPath, read: raw.read.bind(raw), plan: raw.plan.bind(raw), targets: raw.targets.bind(raw), replace: raw.replace.bind(raw), verify: async () => { if (failVerify) { failVerify = false; throw new Error("front door failed"); } } };
  try { const result = await promoteTwoHosts(makePlan(green.baseUrl), { vps, hyper }); assert.equal(result.compensation, "BOTH_HOSTS_RESTORED"); assert.equal(await readFile(vpsPath, "utf8"), traefik("old")); assert.equal(await readFile(hyperPath, "utf8"), apache("http://127.0.0.1:8080")); } finally { await green.close(); }
});
test("write that throws after rename is reconciled and restored", async () => {
  const green = await backend("green"), root = await mkdtemp(join(tmpdir(), "cerp-bg-")), vpsPath = join(root, "dynamic.yml"), hyperPath = join(root, "cerp-local.conf");
  await writeFile(vpsPath, traefik("old")); await writeFile(hyperPath, apache("http://127.0.0.1:8080"));
  const raw = new TraefikFileRouteAdapter(vpsPath, { httpRouter: "api", websocketRouter: "ws" }); let first = true; const vps = { path: vpsPath, read: raw.read.bind(raw), plan: raw.plan.bind(raw), targets: raw.targets.bind(raw), verify: async () => {}, replace: async (...args) => { const result = await raw.replace(...args); if (first) { first = false; throw new Error("lost reply"); } return result; } };
  const h = new ApacheRouteAdapter(hyperPath), hyper = { path: hyperPath, read: h.read.bind(h), plan: h.plan.bind(h), targets: h.targets.bind(h), verify: async () => {}, replace: h.replace.bind(h) };
  try { const result = await promoteTwoHosts(makePlan(green.baseUrl), { vps, hyper }); assert.equal(result.compensation, "BOTH_HOSTS_RESTORED"); assert.equal(await readFile(vpsPath, "utf8"), traefik("old")); } finally { await green.close(); }
});
test("foreign CAS change is never overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "cerp-bg-")), path = join(root, "dynamic.yml"), adapter = new TraefikFileRouteAdapter(path, { httpRouter: "api", websocketRouter: "ws" });
  await writeFile(path, traefik("old")); const baseline = await adapter.read(); await writeFile(path, traefik("foreign"));
  await assert.rejects(adapter.replace(baseline.hash, traefik("green")), /route baseline changed/);
  assert.equal(await readFile(path, "utf8"), traefik("foreign"));
});
test("failed HYPER restoration still restores VPS and reports the partial failure", async () => {
  const green = await backend("green"), root = await mkdtemp(join(tmpdir(), "cerp-bg-")), vpsPath = join(root, "dynamic.yml"), hyperPath = join(root, "cerp-local.conf");
  await writeFile(vpsPath, traefik("old")); await writeFile(hyperPath, apache("http://127.0.0.1:8080"));
  const vps = new TraefikFileRouteAdapter(vpsPath, { httpRouter: "api", websocketRouter: "ws" }); vps.verify = async () => {};
  const raw = new ApacheRouteAdapter(hyperPath); let writes = 0; const hyper = { path: hyperPath, read: raw.read.bind(raw), plan: raw.plan.bind(raw), targets: raw.targets.bind(raw), verify: async () => { throw new Error("verify"); }, replace: async (...args) => { writes += 1; if (writes > 1) throw new Error("restore unavailable"); return raw.replace(...args); } };
  try { const failure = await assert.rejects(promoteTwoHosts(makePlan(green.baseUrl), { vps, hyper }), /COMPENSATION_FAILED/); assert.equal(await readFile(vpsPath, "utf8"), traefik("old")); } finally { await green.close(); }
});
test("two operators contend on the same files without mixing routes, then release locks after a known failure", async () => {
  const green = await backend("green"), root = await mkdtemp(join(tmpdir(), "cerp-bg-")), vpsPath = join(root, "dynamic.yml"), hyperPath = join(root, "cerp-local.conf");
  await writeFile(vpsPath, traefik("old")); await writeFile(hyperPath, apache("http://127.0.0.1:8080"));
  let releaseVerify, enteredVerify; const waiting = new Promise((resolve) => { releaseVerify = resolve; }); const entered = new Promise((resolve) => { enteredVerify = resolve; });
  const vps = new TraefikFileRouteAdapter(vpsPath, { httpRouter: "api", websocketRouter: "ws" }); vps.verify = async () => { enteredVerify(); return waiting; };
  const rawHyper = new ApacheRouteAdapter(hyperPath), hyper = { path: hyperPath, read: rawHyper.read.bind(rawHyper), plan: rawHyper.plan.bind(rawHyper), targets: rawHyper.targets.bind(rawHyper), verify: async () => {}, replace: async () => { throw new Error("known HYPER failure"); } };
  const first = promoteTwoHosts(makePlan(green.baseUrl), { vps, hyper });
  try { await entered; await assert.rejects(promoteTwoHosts(makePlan(green.baseUrl), { vps, hyper }), /ROUTE_LOCKED/); assert.equal(await readFile(hyperPath, "utf8"), apache("http://127.0.0.1:8080")); releaseVerify(); const result = await first; assert.equal(result.compensation, "BOTH_HOSTS_RESTORED"); assert.equal(await readFile(vpsPath, "utf8"), traefik("old")); vps.verify = async () => {}; const after = await promoteTwoHosts(makePlan(green.baseUrl), { vps, hyper }); assert.equal(after.compensation, "BOTH_HOSTS_RESTORED"); }
  finally { releaseVerify(); await first.catch(() => {}); await green.close(); }
});
