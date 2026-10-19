import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), waitMs);
  try {
    const health = await fetch(`${candidate.baseUrl}/health/ready`, { signal: controller.signal });
    assert.equal(health.status, 200, "candidate readiness failed");
    const body = await health.json();
    assert.equal(body.background_runtime?.role, ROLE, "candidate role is not api");
    assert.equal(body.background_runtime?.ready, true, "candidate is not ready");
    const api = await fetch(`${candidate.baseUrl}/api/v1/auth/me`, { signal: controller.signal });
    assert.ok([200, 401].includes(api.status), "candidate API probe failed");
    await probeWebSocket(candidate.baseUrl, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function probeWebSocket(baseUrl, signal) {
  return new Promise((resolve, reject) => {
    const url = new URL("/socket.io/?EIO=4&transport=websocket", baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, { signal });
    socket.addEventListener("open", () => { socket.close(); resolve(); }, { once: true });
    socket.addEventListener("error", () => reject(new Error("candidate WebSocket probe failed")), { once: true });
  });
}

export class FileRouteAdapter {
  constructor(path) { this.path = path; }
  async read() { const text = await readFile(this.path, "utf8"); return { text, hash: sha256(text) }; }
  async replace(expectedHash, text) {
    const current = await this.read();
    assert.equal(current.hash, expectedHash, "route baseline changed");
    const temporary = `${this.path}.next`;
    const handle = await open(temporary, "w", 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.path);
    assert.equal((await this.read()).hash, sha256(text), "route write verification failed");
    return current;
  }
}

export async function promoteTwoHosts(plan, adapters) {
  validatePlan(plan);
  const vps = await adapters.vps.read();
  const hyper = await adapters.hyper.read();
  await probeCandidate(plan.candidate, plan.waitMs);
  const candidateRoutes = JSON.stringify({ http: plan.candidate.id, websocket: plan.candidate.id });
  await adapters.vps.replace(vps.hash, candidateRoutes);
  try {
    await adapters.hyper.replace(hyper.hash, candidateRoutes);
    return { phase: "promoted", vps: plan.candidate.id, hyper: plan.candidate.id };
  } catch (error) {
    try {
      const changed = await adapters.vps.read();
      await adapters.vps.replace(changed.hash, vps.text);
      assert.equal((await adapters.vps.read()).hash, vps.hash, "VPS compensation verification failed");
      return { phase: "blocked", reason: "HYPER_PROMOTION_FAILED", compensation: "VPS_RESTORED", error: error.constructor.name };
    } catch (compensationError) {
      throw Object.assign(new Error("COMPENSATION_FAILED"), { cause: compensationError, promotionError: error });
    }
  }
}

export async function prepare(plan, baselineText) {
  validatePlan(plan);
  assert.equal(sha256(baselineText), plan.baseline.routeFileSha256, "route baseline changed");
  return { phase: "prepared", priorTarget: plan.routes.http.target, baseline: plan.baseline.routeFileSha256 };
}

export async function promote(plan, baselineText, state, applyRoute) {
  if (typeof applyRoute !== "function") throw Object.assign(new Error("ROUTE_ADAPTER_UNSUPPORTED"), { code: "ROUTE_ADAPTER_UNSUPPORTED" });
  assert.equal(state.phase, "prepared", "candidate was not prepared");
  assert.equal(sha256(baselineText), state.baseline, "route baseline changed");
  await probeCandidate(plan.candidate, plan.waitMs);
  const priorTarget = state.priorTarget;
  try {
    return await applyRoute({ ...state, phase: "promoted", target: plan.candidate.id, priorTarget });
  } catch (error) {
    return { ...state, phase: "prepared", target: priorTarget, compensation: "restored-prior-route", error: error.constructor.name };
  }
}

export function rollback(state) {
  assert.equal(state.phase, "promoted", "nothing promoted");
  return { ...state, phase: "rolled_back", target: state.priorTarget, compensation: "routes-only-no-database-restore" };
}

export async function writeStateAtomically(path, state) {
  const temporary = `${path}.next`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [action, planPath, baselinePath, statePath] = process.argv.slice(2);
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const baseline = await readFile(baselinePath, "utf8");
  const prior = statePath ? JSON.parse(await readFile(statePath, "utf8")) : undefined;
  const next = action === "prepare" ? await prepare(plan, baseline) : action === "promote" ? await promote(plan, baseline, prior) : rollback(prior);
  if (statePath) await writeStateAtomically(statePath, next);
  process.stdout.write(`${JSON.stringify({ phase: next.phase, target: next.target ?? next.priorTarget })}\n`);
}
