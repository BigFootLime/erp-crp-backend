import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { repoAdvOverview, repoAdvOrderChain, repoCreateDeliveryBlock, repoCreatePaymentPromise } = vi.hoisted(() => ({
  repoAdvOverview: vi.fn(),
  repoAdvOrderChain: vi.fn(),
  repoCreateDeliveryBlock: vi.fn(),
  repoCreatePaymentPromise: vi.fn(),
}));

vi.mock("../module/adv-reliability/repository/adv-reliability.repository", () => ({
  repoAdvOverview,
  repoAdvOrderChain,
  repoCreateDeliveryBlock,
  repoResolveDeliveryBlock: vi.fn(),
  repoCreatePaymentPromise,
  repoUpdatePaymentPromise: vi.fn(),
  repoCreateInvoiceDispute: vi.fn(),
  repoUpdateInvoiceDispute: vi.fn(),
}));

import routes from "../module/adv-reliability/routes/adv-reliability.routes";

function app(role: string | null) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    if (role) req.user = { id: 7, username: "tester", role };
    next();
  });
  server.use("/adv", routes);
  server.use((error: { status?: number; code?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ code: error.code, message: error.message });
  });
  return server;
}

describe("SOL-23 ADV RBAC and idempotency HTTP boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses anonymous and standard users on financial data", async () => {
    expect((await request(app(null)).get("/adv/overview?period=custom&from=2026-08-01&to=2026-08-31")).status).toBe(401);
    expect((await request(app("Utilisateur")).get("/adv/overview?period=custom&from=2026-08-01&to=2026-08-31")).status).toBe(403);
    expect(repoAdvOverview).not.toHaveBeenCalled();
  });

  it("allows accounting to read and requires idempotency on writes", async () => {
    repoAdvOverview.mockResolvedValue({ contract_version: "CERP-ADV-1.0.0" });
    expect((await request(app("Comptable")).get("/adv/overview?period=custom&from=2026-08-01&to=2026-08-31")).status).toBe(200);
    const missingKey = await request(app("Comptable")).post("/adv/invoices/1/payment-promises").send({
      amount_ttc: "10.00", currency: "EUR", promised_date: "2026-08-20", owner_user_id: 7, next_action: "Relancer le client", due_date: "2026-08-21",
    });
    expect(missingKey.status).toBe(400);
    expect(repoCreatePaymentPromise).not.toHaveBeenCalled();
  });

  it("prevents a standard commercial user from recording a payment promise", async () => {
    const response = await request(app("Commercial")).post("/adv/invoices/1/payment-promises").set("Idempotency-Key", "promise-0001").send({
      amount_ttc: "10.00", currency: "EUR", promised_date: "2026-08-20", owner_user_id: 7, next_action: "Relancer le client", due_date: "2026-08-21",
    });
    expect(response.status).toBe(403);
    expect(repoCreatePaymentPromise).not.toHaveBeenCalled();
  });

  it("validates that a delivery block points to a structured category", async () => {
    const response = await request(app("Comptable")).post("/adv/deliveries/2ecb92c3-3994-4cec-9f2d-68d0fefb2eb6/blocks").set("Idempotency-Key", "block-0001").send({
      order_id: 12, category: "UNKNOWN", detail: "Blocage", owner_user_id: null, next_action: "Décider", due_date: "2026-08-20",
    });
    expect(response.status).toBe(422);
    expect(repoCreateDeliveryBlock).not.toHaveBeenCalled();
  });
});
