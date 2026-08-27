import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  identify: vi.fn(),
  match: vi.fn(),
  requestApproval: vi.fn(),
  approve: vi.fn(),
  dispute: vi.fn(),
  reject: vi.fn(),
}));

vi.mock("../module/supplier-invoices/supplier-invoice.repository", () => ({
  repoListSupplierInvoices: (...args: unknown[]) => mocks.list(...args),
  repoGetSupplierInvoice: (...args: unknown[]) => mocks.get(...args),
  repoIdentifySupplierInvoice: (...args: unknown[]) => mocks.identify(...args),
  repoMatchSupplierInvoice: (...args: unknown[]) => mocks.match(...args),
  repoRequestSupplierInvoiceApproval: (...args: unknown[]) => mocks.requestApproval(...args),
  repoApproveSupplierInvoice: (...args: unknown[]) => mocks.approve(...args),
  repoDisputeSupplierInvoice: (...args: unknown[]) => mocks.dispute(...args),
  repoRejectSupplierInvoice: (...args: unknown[]) => mocks.reject(...args),
}));

import { errorHandler } from "../middlewares/errorHandler";
import { validationErrorMiddleware } from "../module/auth/middlewares/validationError.middleware";
import supplierInvoiceRoutes from "../module/supplier-invoices/supplier-invoice.routes";

const invoiceId = "11111111-1111-4111-8111-111111111111";

function appFor(role = "Comptable") {
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    req.user = { id: 7, username: "finance", email: "finance@test.invalid", role };
    req.requestId = "supplier-invoice-request";
    req.correlationId = "supplier-invoice-correlation";
    next();
  }) as RequestHandler);
  app.use("/supplier-invoices", supplierInvoiceRoutes);
  app.use(validationErrorMiddleware);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("supplier invoice HTTP boundary", () => {
  it("keeps supplier invoice reads private and capability-scoped", async () => {
    mocks.list.mockResolvedValue({ items: [], total: 0 });
    const response = await request(appFor()).get("/supplier-invoices?status=RECEIVED");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ status: "RECEIVED" }));

    const forbidden = await request(appFor("Secretaire")).get("/supplier-invoices");
    expect(forbidden.status).toBe(403);
  });

  it("requires a durable idempotency key and optimistic version on mutations", async () => {
    mocks.approve.mockResolvedValue({ id: invoiceId, status: "APPROVED", row_version: 5 });
    const missingKey = await request(appFor())
      .post(`/supplier-invoices/${invoiceId}/approve`)
      .send({ expected_version: 4 });
    expect(missingKey.status).toBe(400);
    expect(mocks.approve).not.toHaveBeenCalled();

    const invalidVersion = await request(appFor())
      .post(`/supplier-invoices/${invoiceId}/approve`)
      .set("Idempotency-Key", "supplier-approve-001")
      .send({ expected_version: 0 });
    expect(invalidVersion.status).toBe(422);
    expect(mocks.approve).not.toHaveBeenCalled();

    const accepted = await request(appFor())
      .post(`/supplier-invoices/${invoiceId}/approve`)
      .set("Idempotency-Key", "supplier-approve-001")
      .send({ expected_version: 4 });
    expect(accepted.status).toBe(200);
    expect(mocks.approve).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId,
      idempotencyKey: "supplier-approve-001",
      body: { expected_version: 4 },
      actor: expect.objectContaining({ userId: 7 }),
    }));
  });

  it("never silently turns an automatic variance into a manual match", async () => {
    const response = await request(appFor())
      .post(`/supplier-invoices/${invoiceId}/match`)
      .set("Idempotency-Key", "supplier-match-001")
      .send({ expected_version: 2, mode: "AUTO", manual_justification: "forcer" });
    expect(response.status).toBe(422);
    expect(mocks.match).not.toHaveBeenCalled();
  });
});
