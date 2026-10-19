import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, readFile, rename, writeFile } from "node:fs/promises";

const MAX_WAIT_MS = 30_000;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ROLE = "api";
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function validatePlan(plan) {
  assert.equal(plan.schema, "cerp-blue-green-v1");
  assert.ok(Number.isInteger(plan.waitMs) && plan.waitMs > 0 && plan.waitMs <= MAX_WAIT_MS, "waitMs must be 1..30000");
  assert.equal(plan.candidate.role, ROLE);
  assert.match(plan.candidate.imageDigest, DIGEST, "candidate image must be digest pinned");
  assert.equal(plan.candidate.publicLabels, false, "candidate must not have public labels");
  assert.equal(plan.capacity.vpsFreeGiB >= 20, true, "VPS disk reserve is below 20 GiB");
  assert.equal(plan.routes.http.target, plan.routes.websocket.target, "HTTP and WebSocket targets must match");
  assert.equal(plan.routes.http.host, plan.routes.websocket.host, "HTTP and WebSocket hosts must match");
  assert.ok(["vps", "hyper"].every((name) => plan.hosts[name]?.endpoint), "VPS and HYPER endpoints are required");
  assert.equal(plan.legacyWorkerDrain.required, true, "legacy worker drain must be explicit");
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
    const api = await fetch(candidate.baseUrl + "/api/v1/auth/me", { signal: controller.signal });
    assert.ok([200, 401].includes(api.status), "candidate API probe failed");
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
  async read() { const text = await readFile(this.path, "utf8"); return { text, hash: sha256(text) }; }
  async replace(expectedHash, text) {
    const current = await this.read(); assert.equal(current.hash, expectedHash, "route baseline changed");
    const temporary = this.path + ".next", handle = await open(temporary, "w", 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.path);
    assert.equal((await this.read()).hash, sha256(text), "route write verification failed");
    return current;
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
/** Edits only API and Socket.IO ProxyPass/ProxyPassReverse upstreams. */
export class ApacheRouteAdapter extends FileRouteAdapter {
  constructor(path, { apiPath = "/api/", websocketPath = "/socket.io/" } = {}) { super(path); this.apiPath = apiPath; this.websocketPath = websocketPath; }
  targets(text) {
    const result = {};
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*ProxyPass(?:Reverse)?\s+(\/[^\s]+)\s+(\S+)\s*$/i);
      if (!match || ![this.apiPath, this.websocketPath].includes(match[1])) continue;
      const key = match[1] === this.apiPath ? "http" : "websocket";
      if (result[key] && result[key] !== match[2]) throw new Error("Apache directives disagree");
      result[key] = match[2];
    }
    assert.ok(result.http, "Apache API ProxyPass is missing"); assert.ok(result.websocket, "Apache Socket.IO ProxyPass is missing");
    return result;
  }
  plan(text, target) {
    this.targets(text); let api = 0, websocket = 0;
    const result = text.split(/(\r?\n)/).map((line) => {
      const match = line.match(/^(\s*ProxyPass(?:Reverse)?\s+)(\/[^\s]+)(\s+)\S+(\s*)$/i); if (!match) return line;
      if (match[2] === this.apiPath) { api += 1; return match[1] + match[2] + match[3] + target.http + match[4]; }
      if (match[2] === this.websocketPath) { websocket += 1; return match[1] + match[2] + match[3] + target.websocket + match[4]; }
      return line;
    }).join("");
    assert.ok(api >= 1 && websocket >= 1, "Apache route edit did not update HTTP and WebSocket");
    assert.deepEqual(this.targets(result), target, "Apache route readback differs"); return result;
  }
}
async function restore(adapter, snapshot, changedHash, priorTarget) {
  await adapter.replace(changedHash, snapshot.text);
  assert.equal((await adapter.read()).hash, snapshot.hash, "compensation route readback failed");
  await adapter.verify(priorTarget);
}
function hostTarget(plan, name, adapter) {
  const target = plan.candidate.routes?.[name] ?? plan.candidate.id;
  if (adapter instanceof ApacheRouteAdapter) {
    assert.equal(typeof target, "object", "Apache candidate target must specify API and WebSocket upstreams");
    assert.equal(target.http, target.websocket, "Apache API and WebSocket target must match");
  }
  return target;
}
export async function promoteTwoHosts(plan, adapters) {
  validatePlan(plan);
  assert.equal(typeof adapters.vps.verify, "function", "VPS routed service verification is required");
  assert.equal(typeof adapters.hyper.verify, "function", "HYPER routed service verification is required");
  const vps = await adapters.vps.read(), hyper = await adapters.hyper.read();
  const vpsTarget = hostTarget(plan, "vps", adapters.vps), hyperTarget = hostTarget(plan, "hyper", adapters.hyper);
  const observedVpsPrior = adapters.vps.targets?.(vps.text);
  const vpsPrior = typeof observedVpsPrior === "object" ? observedVpsPrior.http : (observedVpsPrior ?? plan.routes.http.target);
  await probeCandidate(plan.candidate, plan.waitMs);
  let vpsChanged, hyperChanged;
  try {
    await adapters.vps.replace(vps.hash, adapters.vps.plan(vps.text, vpsTarget));
    vpsChanged = await adapters.vps.read(); await adapters.vps.verify(vpsTarget);
    await adapters.hyper.replace(hyper.hash, adapters.hyper.plan(hyper.text, hyperTarget));
    hyperChanged = await adapters.hyper.read(); await adapters.hyper.verify(hyperTarget);
    return { phase: "promoted", vps: vpsTarget, hyper: hyperTarget };
  } catch (error) {
    try {
      if (hyperChanged) await restore(adapters.hyper, hyper, hyperChanged.hash, adapters.hyper.targets(hyper.text));
      if (vpsChanged) await restore(adapters.vps, vps, vpsChanged.hash, vpsPrior);
      return { phase: "blocked", reason: "HYPER_PROMOTION_FAILED", compensation: "VPS_RESTORED", error: error.constructor.name };
    }
    catch (compensationError) { throw Object.assign(new Error("COMPENSATION_FAILED"), { cause: compensationError, promotionError: error }); }
  }
}
export async function prepare(plan, baselineText) {
  validatePlan(plan); assert.equal(sha256(baselineText), plan.baseline.routeFileSha256, "route baseline changed");
  return { phase: "prepared", priorTarget: plan.routes.http.target, baseline: plan.baseline.routeFileSha256 };
}
export async function writeStateAtomically(path, state) { const temporary = path + ".next"; await writeFile(temporary, JSON.stringify(state) + "\n", { mode: 0o600 }); await rename(temporary, path); }
