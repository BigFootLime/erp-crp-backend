import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readiness: vi.fn(),
  get: vi.fn(),
  getCredit: vi.fn(),
  queue: vi.fn(),
  queueCredit: vi.fn(),
  reconcile: vi.fn(),
  reconcileCredit: vi.fn(),
  webhook: vi.fn(),
  getConfiguration: vi.fn(),
  activate: vi.fn(),
  deactivate: vi.fn(),
}));

vi.mock("../module/facturation/electronic-invoicing/electronic-invoice.service", () => ({
  svcElectronicInvoiceReadiness: (...args: unknown[]) => mocks.readiness(...args),
  svcGetElectronicInvoice: (...args: unknown[]) => mocks.get(...args),
  svcGetElectronicCreditNote: (...args: unknown[]) => mocks.getCredit(...args),
  svcQueueElectronicInvoice: (...args: unknown[]) => mocks.queue(...args),
  svcQueueElectronicCreditNote: (...args: unknown[]) => mocks.queueCredit(...args),
  svcReconcileElectronicInvoice: (...args: unknown[]) => mocks.reconcile(...args),
  svcReconcileElectronicCreditNote: (...args: unknown[]) => mocks.reconcileCredit(...args),
  svcHandleElectronicInvoiceWebhook: (...args: unknown[]) => mocks.webhook(...args),
  svcGetSuperPdpConfiguration: (...args: unknown[]) => mocks.getConfiguration(...args),
  svcActivateSuperPdp: (...args: unknown[]) => mocks.activate(...args),
  svcDeactivateSuperPdp: (...args: unknown[]) => mocks.deactivate(...args),
}));

vi.mock("../module/auth/middlewares/auth-rate-limit.middleware", () => ({
  electronicInvoiceWebhookRateLimit: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

import { errorHandler } from "../middlewares/errorHandler";
import { validationErrorMiddleware } from "../module/auth/middlewares/validationError.middleware";
import electronicInvoiceWebhookRoutes from "../module/facturation/electronic-invoicing/electronic-invoice-webhook.routes";
import factureRoutes from "../module/facturation/routes/factures.routes";
import avoirRoutes from "../module/facturation/routes/avoirs.routes";

function financeApp(options: { role?: string; authenticated?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    if (options.authenticated !== false) {
      req.user = { id: 7, username: "finance", email: "finance@test.invalid", role: options.role ?? "Comptable" };
    }
    req.requestId = "request-sol26";
    req.correlationId = "correlation-sol26";
    next();
  }) as RequestHandler);
  app.use("/factures", factureRoutes);
  app.use("/avoirs", avoirRoutes);
  app.use(validationErrorMiddleware);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("SOL-26 electronic invoicing HTTP boundary", () => {
  it("exposes an honest unavailable readiness state", async () => {
    mocks.readiness.mockResolvedValue({ ready: false, reason: "NO_QUALIFIED_PROVIDER" });
    const response = await request(financeApp()).get("/factures/electronic-invoicing/readiness");
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ready: false, reason: "NO_QUALIFIED_PROVIDER" });
  });

  it("queues once with an explicit format and idempotency key", async () => {
    mocks.queue.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", idempotent_replay: false });
    const response = await request(financeApp())
      .post("/factures/42/electronic-invoicing/submissions")
      .set("Idempotency-Key", "einvoice-submit-42-001")
      .send({ format: "UBL" });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(mocks.queue).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: 42,
      format: "UBL",
      idempotencyKey: "einvoice-submit-42-001",
      actor: expect.objectContaining({ userId: 7, requestId: "request-sol26" }),
    }));
  });

  it("queues an issued credit note through the same idempotent provider boundary", async () => {
    mocks.queueCredit.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      document_type: "CREDIT_NOTE",
      credit_note_id: 17,
      idempotent_replay: false,
    });
    const response = await request(financeApp())
      .post("/avoirs/17/electronic-invoicing/submissions")
      .set("Idempotency-Key", "einvoice-credit-17-001")
      .send({ format: "UBL" });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(mocks.queueCredit).toHaveBeenCalledWith(expect.objectContaining({
      creditNoteId: 17,
      format: "UBL",
      idempotencyKey: "einvoice-credit-17-001",
      actor: expect.objectContaining({ userId: 7 }),
    }));
  });

  it("rejects an unsupported format before the service", async () => {
    const response = await request(financeApp())
      .post("/factures/42/electronic-invoicing/submissions")
      .set("Idempotency-Key", "einvoice-submit-42-002")
      .send({ format: "PDF" });
    expect(response.status).toBe(400);
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it("keeps submission forbidden for the technical administrator", async () => {
    const response = await request(financeApp({ role: "Administrateur Systeme et Reseau" }))
      .post("/factures/42/electronic-invoicing/submissions")
      .set("Idempotency-Key", "einvoice-submit-42-003")
      .send({ format: "UBL" });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "FINANCE_CAPABILITY_REQUIRED" });
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it("reserves SUPER PDP activation to an electronic-invoicing administrator", async () => {
    mocks.activate.mockResolvedValue({ providerCode: "super-pdp-sandbox", idempotent_replay: false });
    const forbidden = await request(financeApp({ role: "Comptable" }))
      .post("/factures/electronic-invoicing/provider-configuration/activate")
      .set("Idempotency-Key", "super-pdp-activate-001")
      .send({ formats: ["UBL", "CII"], qualification_reference: "sandbox-qualified-2026" });
    expect(forbidden.status).toBe(403);
    expect(mocks.activate).not.toHaveBeenCalled();

    const allowed = await request(financeApp({ role: "Administrateur Systeme et Reseau" }))
      .post("/factures/electronic-invoicing/provider-configuration/activate")
      .set("Idempotency-Key", "super-pdp-activate-001")
      .send({ formats: ["UBL", "CII"], qualification_reference: "sandbox-qualified-2026" });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    expect(mocks.activate).toHaveBeenCalledWith(expect.objectContaining({
      formats: ["UBL", "CII"],
      qualificationReference: "sandbox-qualified-2026",
      idempotencyKey: "super-pdp-activate-001",
      actor: expect.objectContaining({ userId: 7 }),
    }));
  });

  it("does not expose provider configuration to an anonymous caller", async () => {
    const response = await request(financeApp({ authenticated: false }))
      .get("/factures/electronic-invoicing/provider-configuration");
    expect(response.status).toBe(401);
    expect(mocks.getConfiguration).not.toHaveBeenCalled();
  });

  it("keeps the signed webhook route independent from JWT and preserves raw bytes", async () => {
    mocks.webhook.mockResolvedValue({ documentId: "11111111-1111-4111-8111-111111111111", replay: false });
    const app = express();
    app.use(express.json({ verify: (req, _res, body) => { (req as express.Request).rawBody = Buffer.from(body); } }));
    app.use(((req, _res, next) => {
      req.requestId = "request-webhook";
      req.correlationId = "correlation-webhook";
      next();
    }) as RequestHandler);
    app.use("/webhooks", electronicInvoiceWebhookRoutes);
    app.use(validationErrorMiddleware);
    app.use(errorHandler);
    const response = await request(app)
      .post("/webhooks/qualified-pa")
      .set("X-PA-Signature", "signed-value")
      .send({ event_id: "evt-1" });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(mocks.webhook).toHaveBeenCalledWith(expect.objectContaining({
      providerCode: "qualified-pa",
      body: expect.any(Buffer),
      requestId: "request-webhook",
    }));
  });
});
