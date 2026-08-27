import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  transaction: vi.fn(),
  payment: vi.fn(),
}));

vi.mock("../module/facturation/electronic-invoicing/electronic-invoice-reporting.service", () => ({
  svcListEReportingPeriods: (...args: unknown[]) => mocks.list(...args),
  svcCreateEReportingTransaction: (...args: unknown[]) => mocks.transaction(...args),
  svcCreateEReportingPayment: (...args: unknown[]) => mocks.payment(...args),
}));

import { errorHandler } from "../middlewares/errorHandler";
import { validationErrorMiddleware } from "../module/auth/middlewares/validationError.middleware";
import reportingRoutes from "../module/facturation/electronic-invoicing/electronic-invoice-reporting.routes";

const supplierInvoiceId = "11111111-1111-4111-8111-111111111111";

function appFor(role = "Comptable") {
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    req.user = { id: 7, username: "finance", email: "finance@test.invalid", role };
    req.requestId = "ereporting-request";
    req.correlationId = "ereporting-correlation";
    next();
  }) as RequestHandler);
  app.use("/electronic-invoicing", reportingRoutes);
  app.use(validationErrorMiddleware);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("e-reporting HTTP boundary", () => {
  it("keeps period monitoring private and capability-scoped", async () => {
    mocks.list.mockResolvedValue({ data: [], meta: { enabled: false, configuration_ready: false } });
    const response = await request(appFor()).get("/electronic-invoicing/reporting-periods?kind=TRANSACTION&role=SELLER");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(mocks.list).toHaveBeenCalledWith({ kind: "TRANSACTION", role: "SELLER", limit: 100 });

    const forbidden = await request(appFor("Secretaire")).get("/electronic-invoicing/reporting-periods");
    expect(forbidden.status).toBe(403);
  });

  it("requires idempotency and matches each source type to its identifier contract", async () => {
    mocks.transaction.mockResolvedValue({ id: "report-1", idempotent_replay: false });
    const missingKey = await request(appFor())
      .post("/electronic-invoicing/reporting-transactions")
      .send({ source_type: "CUSTOMER_INVOICE", source_id: 42, expected_version: 3 });
    expect(missingKey.status).toBe(400);

    const invalidSource = await request(appFor())
      .post("/electronic-invoicing/reporting-transactions")
      .set("Idempotency-Key", "ereporting-transaction-001")
      .send({ source_type: "SUPPLIER_INVOICE", source_id: 42, expected_version: 3 });
    expect(invalidSource.status).toBe(400);

    const accepted = await request(appFor())
      .post("/electronic-invoicing/reporting-transactions")
      .set("Idempotency-Key", "ereporting-transaction-002")
      .send({ source_type: "SUPPLIER_INVOICE", source_id: supplierInvoiceId, expected_version: 3 });
    expect(accepted.status).toBe(202);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.objectContaining({
      body: { source_type: "SUPPLIER_INVOICE", source_id: supplierInvoiceId, expected_version: 3 },
      idempotencyKey: "ereporting-transaction-002",
      actor: expect.objectContaining({ userId: 7 }),
    }));
  });

  it("requires optimistic payment versions", async () => {
    const response = await request(appFor())
      .post("/electronic-invoicing/reporting-payments")
      .set("Idempotency-Key", "ereporting-payment-001")
      .send({ paiement_id: 5, facture_id: 8, expected_version: 0 });
    expect(response.status).toBe(400);
    expect(mocks.payment).not.toHaveBeenCalled();
  });
});
