import { EventEmitter } from "events";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentRole: { value: "Responsable Stock" as string | null },
  overview: vi.fn(),
  simulate: vi.fn(),
  policy: vi.fn(),
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();
  return { Pool: vi.fn(() => ({ on: emitter.on.bind(emitter), query: vi.fn(), connect: vi.fn() })), __emitter__: emitter };
});
vi.mock("../utils/checkNetworkDrive", () => ({ checkNetworkDrive: vi.fn(() => Promise.resolve()) }));
vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; role: string } },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (mocks.currentRole.value === null) {
      res.status(401).json({ code: "UNAUTHORIZED" });
      return;
    }
    req.user = { id: 11, role: mocks.currentRole.value };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../module/stock-intelligence/repository/stock-intelligence.repository", () => ({
  repoStockIntelligenceOverview: mocks.overview,
  repoSimulateStockIntelligence: mocks.simulate,
  repoCreateStockIntelligencePolicy: mocks.policy,
}));

import app from "../config/app";

const BASE = "/api/v1/stock/intelligence";
const ARTICLE = "11111111-1111-4111-8111-111111111111";
const MAGASIN = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentRole.value = "Responsable Stock";
  mocks.overview.mockResolvedValue({ contract_version: "CERP-STOCK-INTELLIGENCE-1.0.0", items: [] });
  mocks.simulate.mockResolvedValue({ write_performed: false, projection: { points: [] } });
  mocks.policy.mockResolvedValue({ id: ARTICLE, idempotent_replay: false });
});

describe("SOL-19 stock intelligence RBAC and contracts", () => {
  it("denies anonymous and unrelated roles", async () => {
    mocks.currentRole.value = null;
    expect((await request(app).get(`${BASE}/overview`)).status).toBe(401);
    mocks.currentRole.value = "Commercial";
    expect((await request(app).get(`${BASE}/overview`)).status).toBe(403);
    expect((await request(app).post(`${BASE}/simulate`).send({})).status).toBe(403);
  });

  it("allows a stock reader to inspect and simulate without cost disclosure", async () => {
    mocks.currentRole.value = "Employee";
    const overview = await request(app).get(`${BASE}/overview`).query({ as_of: "2026-08-13", weeks: 13 });
    expect(overview.status).toBe(200);
    expect(overview.headers["cache-control"]).toContain("no-store");
    expect(mocks.overview).toHaveBeenCalledWith(expect.objectContaining({ weeks: 13 }), false);

    const simulation = await request(app).post(`${BASE}/simulate`).send({
      as_of: "2026-08-13",
      article_id: ARTICLE,
      magasin_id: MAGASIN,
      weeks: 13,
      proposed_stock_qty: 5,
      expected_receipt_date: "2026-08-20",
    });
    expect(simulation.status).toBe(200);
    expect(simulation.body.write_performed).toBe(false);
  });

  it("rejects invalid dates and a simulated receipt before the observation date", async () => {
    expect((await request(app).get(`${BASE}/overview`).query({ as_of: "2026-02-31" })).status).toBe(422);
    const simulation = await request(app).post(`${BASE}/simulate`).send({
      as_of: "2026-08-13",
      article_id: ARTICLE,
      magasin_id: MAGASIN,
      weeks: 13,
      proposed_stock_qty: 5,
      expected_receipt_date: "2026-08-12",
    });
    expect(simulation.status).toBe(422);
    expect(mocks.simulate).not.toHaveBeenCalled();
  });

  it("reserves policy versions to stock referential managers and requires idempotency", async () => {
    const body = {
      valid_from: "2026-09-01",
      abc_lookback_days: 365,
      abc_a_cumulative_pct: 80,
      abc_b_cumulative_pct: 95,
      dormant_after_days: 180,
      consumption_lookback_days: 91,
      coverage_weeks: 13,
      inventory_tolerance_pct: 0.5,
      inventory_absolute_tolerance_qty: 0.001,
      reason: "Décision Direction SOL-19",
    };
    mocks.currentRole.value = "Employee";
    expect((await request(app).post(`${BASE}/policies`).set("Idempotency-Key", "sol19-policy-0001").send(body)).status).toBe(403);
    mocks.currentRole.value = "Responsable Stock";
    expect((await request(app).post(`${BASE}/policies`).send(body)).status).toBe(400);
    expect((await request(app).post(`${BASE}/policies`).set("Idempotency-Key", "sol19-policy-0001").send(body)).status).toBe(201);
  });
});
