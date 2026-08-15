import { EventEmitter } from "events";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentRole: { value: "Magasinier" as string | null },
  capabilities: vi.fn(),
  issue: vi.fn(),
  list: vi.fn(),
  print: vi.fn(),
  invalidate: vi.fn(),
  replace: vi.fn(),
  resolve: vi.fn(),
  sync: vi.fn(),
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();
  const pool = { on: emitter.on.bind(emitter), query: vi.fn(), connect: vi.fn() };
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});
vi.mock("../utils/checkNetworkDrive", () => ({ checkNetworkDrive: vi.fn(() => Promise.resolve()) }));
vi.mock("../module/access-control/middlewares/module-access-gate", () => ({ moduleAccessGate: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; username: string; email: string; role: string } },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (mocks.currentRole.value === null) { res.status(401).json({ error: "UNAUTHORIZED" }); return; }
    req.user = { id: 31, username: "sol30", email: "sol30@test.invalid", role: mocks.currentRole.value };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../module/identification/identification.service", () => ({
  identificationCapabilities: mocks.capabilities,
  issueLabel: mocks.issue,
  listLabels: mocks.list,
  printLabel: mocks.print,
  invalidateLabel: mocks.invalidate,
  replaceLabel: mocks.replace,
  resolveIdentification: mocks.resolve,
  syncOfflineIdentification: mocks.sync,
}));

import app from "../config/app";

const LABEL = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentRole.value = "Magasinier";
  mocks.capabilities.mockResolvedValue({ contract_version: 1, entities: [] });
  mocks.list.mockResolvedValue({ items: [] });
  mocks.issue.mockResolvedValue({ label: { id: LABEL }, idempotent_replay: false });
  mocks.resolve.mockResolvedValue({ ok: true, event_id: EVENT, result_code: "RESOLVED", message: "ok", requires_online_confirmation: true, idempotent_replay: false });
  mocks.sync.mockResolvedValue({ contract_version: 1, processed: 1, resolved: 1, rejected: 0, results: [] });
});

describe("SOL-30 identification route contract", () => {
  it("refuse tout appel anonyme", async () => {
    mocks.currentRole.value = null;
    expect((await request(app).get("/api/v1/traceability/identification/capabilities")).status).toBe(401);
    expect((await request(app).post("/api/v1/traceability/identification/resolve").send({})).status).toBe(401);
  });

  it("valide le corps avant d'émettre une étiquette et transmet l'idempotency key", async () => {
    const invalid = await request(app)
      .post("/api/v1/traceability/identification/labels")
      .set("Idempotency-Key", KEY)
      .send({ entity_type: "WORK_ORDER", entity_id: "12", site_code: "inventé" });
    expect(invalid.status).toBe(400);
    expect(mocks.issue).not.toHaveBeenCalled();

    const valid = await request(app)
      .post("/api/v1/traceability/identification/labels")
      .set("Idempotency-Key", KEY)
      .send({ entity_type: "WORK_ORDER", entity_id: "12" });
    expect(valid.status).toBe(201);
    expect(mocks.issue).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: KEY, actor: expect.objectContaining({ user_id: 31, role: "Magasinier" }) }));
  });

  it("conserve les refus RBAC comme réponses négatives explicites", async () => {
    mocks.resolve.mockResolvedValue({ ok: false, event_id: EVENT, result_code: "INSUFFICIENT_PERMISSION", message: "Accès insuffisant", requires_online_confirmation: true, idempotent_replay: false });
    const response = await request(app).post("/api/v1/traceability/identification/resolve").send({
      event_id: EVENT,
      code: `CERP:1:${LABEL}`,
      source: "KEYBOARD",
      flow: "QUALITY_CONTROL",
      expected_entity_types: ["QUALITY_CONTROL"],
      client_scanned_at: "2026-08-14T10:00:00.000Z",
    });
    expect(response.status).toBe(403);
    expect(response.body.result_code).toBe("INSUFFICIENT_PERMISSION");
  });

  it("borne le rejeu hors ligne à 50 lectures", async () => {
    const event = { event_id: EVENT, code: `CERP:1:${LABEL}`, source: "MANUAL", flow: "TRACEABILITY", expected_entity_types: [], client_scanned_at: "2026-08-14T10:00:00.000Z" };
    const response = await request(app).post("/api/v1/traceability/identification/offline/sync").send({ events: Array.from({ length: 51 }, () => event) });
    expect(response.status).toBe(400);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
