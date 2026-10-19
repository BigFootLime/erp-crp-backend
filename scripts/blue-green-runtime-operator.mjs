import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_WAIT_MS = 30_000;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ROLE = "api";
const locks = new Map();
async function syncParent(path) {
  if (process.platform !== "linux") return;
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function acquireExternalLock(path) {
  const lockPath = path + ".cerp-blue-green.lock", nonce = randomUUID();
  let handle;
  try { handle = await open(lockPath, "wx", 0o600); await handle.writeFile(nonce); await handle.sync(); }
  catch (error) { throw Object.assign(new Error("ROUTE_LOCKED"), { cause: error, path }); }
  await handle.close(); await syncParent(lockPath);
  return async () => {
    const held = await readFile(lockPath, "utf8").catch(() => undefined);
    assert.equal(held, nonce, "route lock ownership changed");
    await unlink(lockPath); await syncParent(lockPath);
  };
}
async function withRouteLocks(adapters, fn) {
  assert.ok(Object.values(adapters).every((adapter) => typeof adapter.path === "string" && adapter.path.length > 0), "each route adapter requires a lock path");
  const paths = Object.entries(adapters).map(([name, adapter]) => ({ name, adapter })).sort((a, b) => `${a.name}:${a.adapter.path}`.localeCompare(`${b.name}:${b.adapter.path}`));
  const releases = [];
  try { for (const { adapter } of paths) releases.push(await (adapter.acquireLock?.() ?? acquireExternalLock(adapter.path))); return await fn(); }
  finally { for (const release of releases.reverse()) await release(); }
}
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function sameUpstreamOrigin(left, right) {
  if (left === right) return true;
  try {
    const a = new URL(left), b = new URL(right);
    assert.equal(a.username + a.password + b.username + b.password, "", "upstream credentials are not allowed");
    return a.hostname.toLowerCase() === b.hostname.toLowerCase() && a.port === b.port;
  } catch { return false; }
}
function assertSameUpstreamOrigin(left, right, message) { assert.equal(sameUpstreamOrigin(left, right), true, message); }

export function validatePlan(plan) {
  assert.equal(plan.schema, "cerp-blue-green-v1");
  assert.ok(Number.isInteger(plan.waitMs) && plan.waitMs > 0 && plan.waitMs <= MAX_WAIT_MS, "waitMs must be 1..30000");
  assert.equal(plan.candidate.role, ROLE);
  assert.match(plan.candidate.imageDigest, DIGEST, "candidate image must be digest pinned");
  assert.equal(plan.candidate.publicLabels, false, "candidate must not have public labels");
  assert.equal(plan.capacity.vpsFreeGiB >= 20, true, "VPS disk reserve is below 20 GiB");
  assertSameUpstreamOrigin(plan.routes.http.target, plan.routes.websocket.target, "HTTP and WebSocket targets must use the same upstream host and port");
  assert.equal(plan.routes.http.host, plan.routes.websocket.host, "HTTP and WebSocket hosts must match");
  assert.ok(["vps", "hyper"].every((name) => plan.hosts[name]?.endpoint), "VPS and HYPER endpoints are required");
  assert.equal(plan.legacyWorkerDrain.required, true, "legacy worker drain must be explicit");
  assert.match(plan.candidate.version, /^[a-f0-9]{40}$/, "candidate version must be an exact commit SHA");
  assert.ok(["vps", "hyper"].every((name) => /^[a-f0-9]{64}$/.test(plan.baseline?.hosts?.[name]?.sha256)), "host baseline hashes are required");
  return plan;
}
export async function probeCandidate(candidate, waitMs) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), waitMs);
  try {
    const health = await fetch(candidate.baseUrl + "/health/ready", { signal: controller.signal });
    assert.equal(health.status, 200, "candidate readiness failed");
    const body = await health.json();
    assert.equal(body.background_runtime?.role, ROLE, "candidate role is not api");
    assert.equal(body.background_runtime?.ready, true, "candidate is not ready");
    assert.equal(body.version, candidate.version, "candidate version differs");
    const api = await fetch(candidate.baseUrl + "/api/v1/auth/me", { signal: controller.signal });
    assert.equal(api.status, 401, "candidate API probe must be unauthorized");
    await probeWebSocket(candidate.baseUrl, controller.signal);
  } finally { clearTimeout(timer); }
}
function probeWebSocket(baseUrl, signal) {
  return new Promise((resolve, reject) => {
    const url = new URL("/socket.io/?EIO=4&transport=websocket", baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (signal.aborted) return reject(signal.reason ?? new Error("candidate WebSocket probe timed out"));
    const socket = new WebSocket(url);
    const abort = () => { socket.close(); reject(signal.reason ?? new Error("candidate WebSocket probe timed out")); };
    socket.addEventListener("open", () => { signal.removeEventListener("abort", abort); socket.close(); resolve(); }, { once: true });
    socket.addEventListener("error", () => { signal.removeEventListener("abort", abort); reject(new Error("candidate WebSocket probe failed")); }, { once: true });
    signal.addEventListener("abort", abort, { once: true });
  });
}
export class FileRouteAdapter {
  constructor(path) { this.path = path; }
  async read() { const info = await lstat(this.path); assert.ok(info.isFile() && !info.isSymbolicLink(), "route file must be a regular non-symlink"); const text = await readFile(this.path, "utf8"); return { text, hash: sha256(text) }; }
  async locked(fn) {
    const prior = locks.get(this.path) ?? Promise.resolve(); let release;
    const next = new Promise((resolve) => { release = resolve; }); locks.set(this.path, prior.then(() => next));
    await prior; try { return await fn(); } finally { release(); if (locks.get(this.path) === next) locks.delete(this.path); }
  }
  async replace(expectedHash, text) {
    return this.locked(async () => {
      const info = await lstat(this.path); assert.ok(info.isFile() && !info.isSymbolicLink(), "route file must be a regular non-symlink");
      const current = await this.read(); assert.equal(current.hash, expectedHash, "route baseline changed");
      const temporary = this.path + "." + randomUUID() + ".next"; let handle;
      try { handle = await open(temporary, "wx", info.mode & 0o777); await handle.writeFile(text); await handle.sync(); await handle.close(); handle = undefined; await chmod(temporary, info.mode & 0o777); await rename(temporary, this.path); await syncParent(this.path); assert.equal((await this.read()).hash, sha256(text), "route write verification failed"); return current; }
      finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
    });
  }
}
function quoted(value) { return value.replace(/^['"]|['"]$/g, ""); }
/** Edits only two named Traefik router service fields; all other provider content is retained. */
export class TraefikFileRouteAdapter extends FileRouteAdapter {
  constructor(path, { httpRouter, websocketRouter }) { super(path); this.httpRouter = httpRouter; this.websocketRouter = websocketRouter; }
  targets(text) {
    const section = text.split(/^\s*services:\s*$/m)[0]; assert.ok(section, "Traefik routers section is missing");
    const targets = {}; let router;
    for (const line of section.split(/\r?\n/)) {
      const heading = line.match(/^ {4}([^:#][^:]*):\s*$/); if (heading) router = heading[1];
      const service = line.match(/^ {6}service:\s*([^\s#]+)\s*(?:#.*)?$/);
      if (service && (router === this.httpRouter || router === this.websocketRouter)) {
        assert.equal(targets[router], undefined, "Traefik router has multiple services");
        targets[router] = quoted(service[1]);
      }
    }
    assert.ok(targets[this.httpRouter], "Traefik HTTP router is missing"); assert.ok(targets[this.websocketRouter], "Traefik WebSocket router is missing");
    return { http: targets[this.httpRouter], websocket: targets[this.websocketRouter] };
  }
  plan(text, target) {
    this.targets(text); let router, replacements = 0;
    const result = text.split(/(\r?\n)/).map((line) => {
      const heading = line.match(/^ {4}([^:#][^:]*):\s*$/); if (heading) router = heading[1];
      if ((router === this.httpRouter || router === this.websocketRouter) && /^ {6}service:\s*[^\s#]+\s*(?:#.*)?$/.test(line)) { replacements += 1; return "      service: " + target; }
      return line;
    }).join("");
    assert.equal(replacements, 2, "Traefik route edit did not update HTTP and WebSocket exactly once");
    assert.deepEqual(this.targets(result), { http: target, websocket: target }, "Traefik route readback differs");
    return result;
  }
}
/**
 * Edits the primary API and Socket.IO ProxyPass upstreams and only their
 * matching ProxyPassReverse directives.  Additional reverse mappings are
 * application exceptions (for example GED/test listeners) and are retained.
 */
export class ApacheRouteAdapter extends FileRouteAdapter {
  constructor(path, { apiPath = "/api/", websocketPath = "/socket.io/" } = {}) { super(path); this.apiPath = apiPath; this.websocketPath = websocketPath; }
  targets(text) {
    const result = {}, reverses = {};
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(ProxyPass(?:Reverse)?)\s+(\/[^\s]+)\s+(\S+)(?:\s+.*)?$/i);
      if (!match || ![this.apiPath, this.websocketPath].includes(match[2])) continue;
      const key = match[2] === this.apiPath ? "http" : "websocket";
      if (match[1].toLowerCase() === "proxypass") {
        assert.equal(result[key], undefined, `Apache ${key} has multiple primary ProxyPass directives`);
        result[key] = match[3];
      } else (reverses[key] ??= []).push(match[3]);
    }
    assert.ok(result.http, "Apache API ProxyPass is missing"); assert.ok(result.websocket, "Apache Socket.IO ProxyPass is missing");
    for (const key of ["http", "websocket"]) assert.equal(reverses[key]?.filter((upstream) => upstream === result[key]).length, 1, `Apache ${key} primary ProxyPassReverse is missing or ambiguous`);
    return result;
  }
  plan(text, target) {
    assertSameUpstreamOrigin(target.http, target.websocket, "Apache API and WebSocket targets must use the same upstream host and port");
    const prior = this.targets(text); let api = 0, websocket = 0, apiReverse = 0, websocketReverse = 0;
    const result = text.split(/(\r?\n)/).map((line) => {
      const match = line.match(/^(\s*)(ProxyPass(?:Reverse)?)(\s+)(\/[^\s]+)(\s+)(\S+)(.*)$/i); if (!match) return line;
      const key = match[4] === this.apiPath ? "http" : match[4] === this.websocketPath ? "websocket" : undefined;
      if (!key) return line;
      const reverse = match[2].toLowerCase() === "proxypassreverse";
      if (!reverse) {
        if (key === "http") api += 1; else websocket += 1;
        return match[1] + match[2] + match[3] + match[4] + match[5] + target[key] + match[7];
      }
      if (match[6] !== prior[key]) return line;
      if (key === "http") apiReverse += 1; else websocketReverse += 1;
      return match[1] + match[2] + match[3] + match[4] + match[5] + target[key] + match[7];
    }).join("");
    assert.equal(api, 1, "Apache route edit did not update API exactly once"); assert.equal(websocket, 1, "Apache route edit did not update Socket.IO exactly once");
    assert.equal(apiReverse, 1, "Apache route edit did not update primary API reverse exactly once"); assert.equal(websocketReverse, 1, "Apache route edit did not update primary Socket.IO reverse exactly once");
    assert.deepEqual(this.targets(result), target, "Apache route readback differs"); return result;
  }
}
/**
 * Host-aware adapter boundary. Its transport owns the remote SSH execution;
 * it must implement remote locking, hash CAS, and reload-plus-front-door
 * verification. This module intentionally supplies no shell fallback.
 */
export class RemoteRouteAdapter {
  constructor({ endpoint, path, format, transport }) {
    assert.ok(typeof endpoint === "string" && endpoint.length > 0, "remote endpoint is required");
    assert.ok(typeof path === "string" && path.startsWith("/"), "remote route path is required");
    assert.ok(format && typeof format.targets === "function" && typeof format.plan === "function", "remote route format is required");
    for (const method of ["acquireRouteLock", "releaseRouteLock", "readRoute", "compareAndSwapRoute", "reloadAndVerifyRoute"]) assert.equal(typeof transport?.[method], "function", `remote transport.${method} is required`);
    this.endpoint = endpoint; this.path = path; this.format = format; this.transport = transport;
    this.targetKind = format instanceof ApacheRouteAdapter ? "apache" : "traefik";
  }
  async acquireLock() {
    const token = await this.transport.acquireRouteLock({ endpoint: this.endpoint, path: this.path });
    assert.ok(typeof token === "string" && token.length > 0, "remote route lock token is required");
    return async () => { const result = await this.transport.releaseRouteLock({ endpoint: this.endpoint, path: this.path, token }); assert.equal(result?.released, true, "remote route lock release failed"); };
  }
  async read() {
    const result = await this.transport.readRoute({ endpoint: this.endpoint, path: this.path });
    assert.equal(typeof result?.text, "string", "remote route read text is required");
    assert.equal(result.sha256, sha256(result.text), "remote route read hash is invalid");
    return result;
  }
  targets(text) { return this.format.targets(text); }
  plan(text, target) { return this.format.plan(text, target); }
  async replace(expectedHash, text) {
    const result = await this.transport.compareAndSwapRoute({ endpoint: this.endpoint, path: this.path, expectedHash, text, sha256: sha256(text) });
    assert.equal(result?.applied, true, "remote route CAS was not applied"); assert.equal(result.sha256, sha256(text), "remote route CAS hash is invalid");
    const readback = await this.read();
    assert.equal(readback.sha256, sha256(text), "remote route CAS readback failed");
  }
  async verify(target) {
    const result = await this.transport.reloadAndVerifyRoute({ endpoint: this.endpoint, path: this.path, target });
    assert.equal(result?.reloaded, true, "remote route reload was not confirmed"); assert.equal(result?.providerReadable, true, "remote routing provider did not confirm the route file is readable"); assert.equal(result?.verified, true, "remote route front-door verification was not confirmed");
  }
}
async function restore(adapter, snapshot, changedHash, priorTarget) {
  await adapter.replace(changedHash, snapshot.text);
  assert.equal((await adapter.read()).hash, snapshot.hash, "compensation route readback failed");
  await adapter.verify(priorTarget);
}
async function reconcile(adapter, snapshot, candidateText) {
  const current = await adapter.read();
  if (current.hash === snapshot.hash) return { state: "old", hash: current.hash };
  if (current.hash === sha256(candidateText)) return { state: "new", hash: current.hash };
  return { state: "foreign", hash: current.hash };
}
function hostTarget(plan, name, adapter) {
  const target = plan.candidate.routes?.[name] ?? plan.candidate.id;
  if (adapter instanceof ApacheRouteAdapter || adapter.targetKind === "apache") {
    assert.equal(typeof target, "object", "Apache candidate target must specify API and WebSocket upstreams");
    assertSameUpstreamOrigin(target.http, target.websocket, "Apache API and WebSocket targets must use the same upstream host and port");
  }
  return target;
}
export async function promoteTwoHosts(plan, adapters) {
  return withRouteLocks(adapters, async () => {
  validatePlan(plan);
  assert.equal(typeof adapters.vps.verify, "function", "VPS routed service verification is required");
  assert.equal(typeof adapters.hyper.verify, "function", "HYPER routed service verification is required");
  const vps = await adapters.vps.read(), hyper = await adapters.hyper.read();
  assert.equal(vps.hash, plan.baseline.hosts.vps.sha256, "VPS route baseline changed");
  assert.equal(hyper.hash, plan.baseline.hosts.hyper.sha256, "HYPER route baseline changed");
  const vpsTarget = hostTarget(plan, "vps", adapters.vps), hyperTarget = hostTarget(plan, "hyper", adapters.hyper);
  const observedVpsPrior = adapters.vps.targets?.(vps.text);
  const vpsPrior = typeof observedVpsPrior === "object" ? observedVpsPrior.http : (observedVpsPrior ?? plan.routes.http.target);
  await probeCandidate(plan.candidate, plan.waitMs);
  const vpsText = adapters.vps.plan(vps.text, vpsTarget);
  const hyperText = adapters.hyper.plan(hyper.text, hyperTarget);
  try {
    await adapters.vps.replace(vps.hash, vpsText);
    await adapters.vps.verify(vpsTarget);
    await adapters.hyper.replace(hyper.hash, hyperText);
    await adapters.hyper.verify(hyperTarget);
    return { phase: "promoted", vps: vpsTarget, hyper: hyperTarget };
  } catch (error) {
    const states = { vps: await reconcile(adapters.vps, vps, vpsText), hyper: await reconcile(adapters.hyper, hyper, hyperText) };
    const failures = [];
    if (states.hyper.state === "new") await restore(adapters.hyper, hyper, states.hyper.hash, adapters.hyper.targets(hyper.text)).catch((cause) => failures.push({ host: "hyper", cause }));
    if (states.vps.state === "new") await restore(adapters.vps, vps, states.vps.hash, vpsPrior).catch((cause) => failures.push({ host: "vps", cause }));
    const finalStates = { vps: await reconcile(adapters.vps, vps, vpsText), hyper: await reconcile(adapters.hyper, hyper, hyperText) };
    if (failures.length || Object.values(finalStates).some((item) => item.state !== "old")) {
      throw Object.assign(new Error("COMPENSATION_FAILED"), { promotionError: error, failures, states: finalStates });
    }
    return { phase: "blocked", reason: "HOST_PROMOTION_FAILED", compensation: "BOTH_HOSTS_RESTORED", error: error.constructor.name, states: finalStates };
  }
  });
}
export async function prepare(plan, baselineText) {
  validatePlan(plan); assert.equal(sha256(baselineText), plan.baseline.routeFileSha256, "route baseline changed");
  return { phase: "prepared", priorTarget: plan.routes.http.target, baseline: plan.baseline.routeFileSha256 };
}
export async function writeStateAtomically(path, state) { const temporary = path + ".next"; await writeFile(temporary, JSON.stringify(state) + "\n", { mode: 0o600 }); await rename(temporary, path); }
