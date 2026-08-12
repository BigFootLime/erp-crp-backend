import { EventEmitter } from "events";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentRole: { value: "Directeur" as string | null },
  overview: vi.fn(),
  timeline: vi.fn(),
  reminder: vi.fn(),
  loss: vi.fn(),
  discountRequest: vi.fn(),
  discountDecision: vi.fn(),
  expire: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();
  const pool = { on: emitter.on.bind(emitter), query: vi.fn(), connect: vi.fn() };
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({ checkNetworkDrive: vi.fn(() => Promise.resolve()) }));
vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (_req: unknown, _res: unknown, next: () => void) => next(),
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
      id: 7,
      username: "sol17-test",
      email: "sol17@test.invalid",
      role: mocks.currentRole.value,
      primary_role: mocks.currentRole.value,
      roles: [mocks.currentRole.value],
    };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../module/commercial-reliability/repository/commercial-reliability.repository", () => ({
  assertQuoteDiscountApprovedForSubmission: vi.fn(),
  repoCommercialOverview: mocks.overview,
  repoOrderTimeline: mocks.timeline,
  repoRecordQuoteReminder: mocks.reminder,
  repoRecordQuoteLoss: mocks.loss,
  repoRequestDiscountApproval: mocks.discountRequest,
  repoDecideDiscountApproval: mocks.discountDecision,
  repoExpireDueQuotes: mocks.expire,
  repoCancelOrder: mocks.cancel,
}));

import app from "../config/app";

const BASE = "/api/v1/reporting/commercial/reliability";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentRole.value = "Directeur";
  mocks.overview.mockResolvedValue({ envelope: { contract_version: "CERP-COMMERCIAL-1.0.0" }, exceptions: [] });
  mocks.timeline.mockResolvedValue({ commande_id: 9, events: [] });
  mocks.reminder.mockResolvedValue({ event_id: "evt", devis_id: 4, idempotent_replay: false });
  mocks.loss.mockResolvedValue({ devis_id: 4, status: "REFUSE" });
  mocks.discountRequest.mockResolvedValue({ devis_id: 4, status: "PENDING" });
  mocks.discountDecision.mockResolvedValue({ devis_id: 4, status: "APPROVED" });
  mocks.expire.mockResolvedValue({ expired_count: 2 });
  mocks.cancel.mockResolvedValue({ commande_id: 9, status: "ANNULE" });
});

describe("SOL-17 commercial reliability RBAC and contracts", () => {
  it("refuses anonymous and non-financial overview access", async () => {
    mocks.currentRole.value = null;
    expect((await request(app).get(`${BASE}/overview`).query({ from: "2026-01-01", to: "2026-08-12" })).status).toBe(401);
    mocks.currentRole.value = "Operateur";
    expect((await request(app).get(`${BASE}/overview`).query({ from: "2026-01-01", to: "2026-08-12" })).status).toBe(403);
  });

  it("returns the governed overview to Direction", async () => {
    const response = await request(app).get(`${BASE}/overview`).query({ from: "2026-01-01", to: "2026-08-12", currency: "usd" });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body.envelope.contract_version).toBe("CERP-COMMERCIAL-1.0.0");
    expect(mocks.overview).toHaveBeenCalledWith(expect.objectContaining({ currency: "USD" }));
  });

  it("requires an idempotency key for reminders", async () => {
    mocks.currentRole.value = "Commercial";
    const missing = await request(app).post(`${BASE}/quotes/4/reminders`).send({ channel: "EMAIL" });
    expect(missing.status).toBe(400);
    expect(mocks.reminder).not.toHaveBeenCalled();

    const accepted = await request(app)
      .post(`${BASE}/quotes/4/reminders`)
      .set("Idempotency-Key", "sol17-reminder-0001")
      .send({ channel: "EMAIL" });
    expect(accepted.status).toBe(201);
    expect(mocks.reminder).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "sol17-reminder-0001" }));
  });

  it("prevents a standard user from recording a loss", async () => {
    mocks.currentRole.value = "Operateur";
    const response = await request(app)
      .post(`${BASE}/quotes/4/loss`)
      .set("Idempotency-Key", "sol17-loss-0001")
      .send({ reason_code: "PRICE" });
    expect(response.status).toBe(403);
    expect(mocks.loss).not.toHaveBeenCalled();
  });

  it("reserves discount decisions and order cancellation to Direction/Admin", async () => {
    mocks.currentRole.value = "Commercial";
    const forbidden = await request(app)
      .post(`${BASE}/quotes/4/discount-decisions`)
      .set("Idempotency-Key", "sol17-decision-0001")
      .send({ approval_request_id: "11111111-1111-4111-8111-111111111111", decision: "APPROVE", note: "Validé" });
    expect(forbidden.status).toBe(403);

    mocks.currentRole.value = "Directeur";
    const cancel = await request(app)
      .post(`${BASE}/orders/9/cancel`)
      .set("Idempotency-Key", "sol17-cancel-0001")
      .send({ reason_code: "CUSTOMER_CANCELLED" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("ANNULE");
  });
});
