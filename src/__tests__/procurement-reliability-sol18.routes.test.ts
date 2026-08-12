import { EventEmitter } from "events";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentRole: { value: "Directeur" as string | null },
  overview: vi.fn(),
  anomaly: vi.fn(),
  promise: vi.fn(),
  policy: vi.fn(),
  grantModuleAccess: { value: false },
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();
  const pool = { on: emitter.on.bind(emitter), query: vi.fn(), connect: vi.fn() };
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({ checkNetworkDrive: vi.fn(() => Promise.resolve()) }));
vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (req: { accountModuleAccess?: { userId: number; moduleKey: string; granted: boolean } }, _res: unknown, next: () => void) => {
    if (mocks.grantModuleAccess.value) {
      req.accountModuleAccess = { userId: 11, moduleKey: "procurement", granted: true };
    }
    next();
  },
}));
vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; username: string; email: string; role: string; primary_role: string; roles: string[] } },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (mocks.currentRole.value === null) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    req.user = {
      id: 11,
      username: "sol18-test",
      email: "sol18@test.invalid",
      role: mocks.currentRole.value,
      primary_role: mocks.currentRole.value,
      roles: [mocks.currentRole.value],
    };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../module/procurement-reliability/repository/procurement-reliability.repository", () => ({
  repoProcurementOverview: mocks.overview,
  repoUpsertAnomalyAction: mocks.anomaly,
  repoRecordPromisedDate: mocks.promise,
  repoCreateProcurementPolicy: mocks.policy,
  repoRecordInitialPromiseEvent: vi.fn(),
}));

import app from "../config/app";

const BASE = "/api/v1/procurement-reliability";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ANOMALY_KEY = "MISSING_QUANTITY:0123456789abcdef01234567";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentRole.value = "Directeur";
  mocks.grantModuleAccess.value = false;
  mocks.overview.mockResolvedValue({ contract_version: "CERP-PROCUREMENT-1.0.0", anomalies: [] });
  mocks.anomaly.mockResolvedValue({ action: { anomaly_key: ANOMALY_KEY }, idempotent_replay: false });
  mocks.promise.mockResolvedValue({ event_id: ORDER_ID, promised_date: "2026-08-25", idempotent_replay: false });
  mocks.policy.mockResolvedValue({ policy_id: ORDER_ID, valid_from: "2026-09-01", idempotent_replay: false });
});

describe("SOL-18 procurement reliability RBAC and contracts", () => {
  it("denies anonymous and unrelated roles", async () => {
    mocks.currentRole.value = null;
    expect((await request(app).get(`${BASE}/overview`).query({ from: "2026-01-01", to: "2026-08-12" })).status).toBe(401);
    mocks.currentRole.value = "Operateur";
    expect((await request(app).get(`${BASE}/overview`).query({ from: "2026-01-01", to: "2026-08-12" })).status).toBe(403);
  });

  it("returns a no-store scorecard to an authorised buyer", async () => {
    mocks.currentRole.value = "Responsable Achats";
    const response = await request(app).get(`${BASE}/overview`).query({
      from: "2026-01-01",
      to: "2026-08-12",
      dimension: "ARTICLE",
    });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(mocks.overview).toHaveBeenCalledWith(expect.objectContaining({ dimension: "ARTICLE" }), true);
  });

  it("requires idempotency for anomaly triage and promise revisions", async () => {
    mocks.currentRole.value = "Responsable Achats";
    const actionBody = {
      owner_user_id: 11,
      next_action: "Relancer le fournisseur",
      due_date: "2026-08-13",
      status: "IN_PROGRESS",
    };
    expect((await request(app).put(`${BASE}/anomalies/${ANOMALY_KEY}/action`).send(actionBody)).status).toBe(400);
    expect((await request(app)
      .put(`${BASE}/anomalies/${ANOMALY_KEY}/action`)
      .set("Idempotency-Key", "sol18-action-0001")
      .send(actionBody)).status).toBe(200);

    expect((await request(app)
      .post(`${BASE}/orders/${ORDER_ID}/promised-dates`)
      .set("Idempotency-Key", "sol18-promise-0001")
      .send({
        promised_date: "2026-08-25",
        reason_code: "SUPPLIER_DELAY",
        note: "Retard matière confirmé",
        expected_updated_at: "2026-08-12T10:00:00.000Z",
      })).status).toBe(200);
  });

  it("reserves tolerance policy versions to Direction or Admin", async () => {
    mocks.currentRole.value = "Responsable Achats";
    const body = {
      scope_type: "COMPANY",
      scope_id: null,
      valid_from: "2026-09-01",
      price_tolerance_pct: 2,
      over_receipt_tolerance_pct: 0,
      lead_grace_days: 0,
      reason: "Décision Direction",
    };
    expect((await request(app).post(`${BASE}/policies`).set("Idempotency-Key", "sol18-policy-0001").send(body)).status).toBe(403);
    mocks.grantModuleAccess.value = true;
    expect((await request(app).post(`${BASE}/policies`).set("Idempotency-Key", "sol18-policy-0002").send(body)).status).toBe(403);
    mocks.currentRole.value = "Directeur";
    expect((await request(app).post(`${BASE}/policies`).set("Idempotency-Key", "sol18-policy-0001").send(body)).status).toBe(201);
  });
});
