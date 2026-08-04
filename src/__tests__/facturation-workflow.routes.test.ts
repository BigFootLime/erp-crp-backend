import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSources: vi.fn(),
  preview: vi.fn(),
  createDraft: vi.fn(),
  requestValidation: vi.fn(),
  validate: vi.fn(),
  issue: vi.fn(),
}));

vi.mock("../module/facturation/services/facture-workflow.service", () => ({
  svcListEligibleFactureSources: (...args: unknown[]) => mocks.listSources(...args),
  svcPreviewFacture: (...args: unknown[]) => mocks.preview(...args),
  svcCreateFactureDraft: (...args: unknown[]) => mocks.createDraft(...args),
  svcRequestFactureValidation: (...args: unknown[]) => mocks.requestValidation(...args),
  svcValidateFacture: (...args: unknown[]) => mocks.validate(...args),
  svcIssueFacture: (...args: unknown[]) => mocks.issue(...args),
}));

import { validationErrorMiddleware } from "../module/auth/middlewares/validationError.middleware";
import factureRoutes from "../module/facturation/routes/factures.routes";
import { errorHandler } from "../middlewares/errorHandler";
import { HttpError } from "../utils/httpError";

const source = {
  source_type: "DELIVERY_LINE",
  source_id: "11111111-1111-4111-8111-111111111111",
  source_line_id: "22222222-2222-4222-8222-222222222222",
  delivery_number: "BL-000001",
  delivery_status: "SHIPPED",
  client_id: "CLI-1",
  client_name: "Client test",
  commande_id: 67,
  affaire_id: null,
  commande_line_id: 9,
  designation: "Piece test",
  code_piece: "P-1",
  unit: "u",
  quantity_source: "2.000",
  quantity_already_invoiced: "0.000",
  quantity_already_credited: "0.000",
  quantity_remaining: "2.000",
  unit_price_ex_tax: "10.0000",
  discount_percent: "0.0000",
  tax_rate_percent: "20.0000",
  pricing_version: "COMMANDE_LINE:9:v1",
  rule_code: "DELIVERY_SHIPPED:POLICY-1",
  blockers: [],
};

const commandResult = {
  id: 42,
  uuid: "33333333-3333-4333-8333-333333333333",
  draft_reference: "DFT-2026-000042",
  legal_number: null,
  status: "DRAFT",
  row_version: 1,
  correlation_id: "44444444-4444-4444-8444-444444444444",
  idempotent_replay: false,
};

function testApp(options: { granted?: boolean; authenticated?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    if (options.authenticated !== false) {
      req.user = {
        id: 7,
        username: "finance-test",
        email: "finance@test.invalid",
        role: "Employee",
      };
    }
    if (options.granted !== false) {
      req.accountModuleAccess = { userId: 7, moduleKey: "facturation", granted: true };
    }
    req.requestId = "request-test-001";
    next();
  }) as RequestHandler);
  app.use("/factures", factureRoutes);
  app.use(validationErrorMiddleware);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("BUG-CERP-0016 - contrat HTTP workflow facture v1", () => {
  it("retourne les lignes BL eligibles et transmet les filtres types (200)", async () => {
    mocks.listSources.mockResolvedValue({ items: [source], total: 1, policy_active: true });

    const response = await request(testApp())
      .get("/factures/workflow/eligible-sources?commande_id=67&page=2&pageSize=10");

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({ items: [source], total: 1, policy_active: true });
    expect(mocks.listSources).toHaveBeenCalledWith({ commande_id: 67, page: 2, pageSize: 10 });
  });

  it("refuse un filtre de commande invalide avant le service (400)", async () => {
    const response = await request(testApp())
      .get("/factures/workflow/eligible-sources?commande_id=0");

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "VALIDATION_ERROR" });
    expect(mocks.listSources).not.toHaveBeenCalled();
  });

  it("reste fail-closed sans contexte module ni capacite Finance (403)", async () => {
    const response = await request(testApp({ granted: false }))
      .get("/factures/workflow/eligible-sources");

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      success: false,
      code: "FINANCE_CAPABILITY_REQUIRED",
    });
    expect(mocks.listSources).not.toHaveBeenCalled();
  });

  it("retourne 201 au premier brouillon et 200 lors du rejeu idempotent", async () => {
    mocks.createDraft
      .mockResolvedValueOnce(commandResult)
      .mockResolvedValueOnce({ ...commandResult, idempotent_replay: true });
    const body = {
      client_id: "CLI-1",
      currency: "EUR",
      sources: [{
        source_type: "DELIVERY_LINE",
        source_id: source.source_id,
        source_line_id: source.source_line_id,
        quantity: "2.000",
      }],
      global_discount_percent: "0",
      due_dates: [{ due_date: "2026-08-31", label: "Echeance principale" }],
      internal_comment: null,
      customer_text: null,
      preview_hash: "a".repeat(64),
    };

    const first = await request(testApp())
      .post("/factures/workflow/drafts")
      .set("Idempotency-Key", "facture-draft-attempt-001")
      .send(body);
    const replay = await request(testApp())
      .post("/factures/workflow/drafts")
      .set("Idempotency-Key", "facture-draft-attempt-001")
      .send(body);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body.idempotent_replay).toBe(true);
    expect(mocks.createDraft).toHaveBeenNthCalledWith(1, expect.objectContaining({
      idempotencyKey: "facture-draft-attempt-001",
      actor: expect.objectContaining({ userId: 7, requestId: "request-test-001" }),
    }));
  });

  it("propage un conflit de version sans masquer le code de reprise (409)", async () => {
    mocks.requestValidation.mockRejectedValue(
      new HttpError(409, "CONCURRENT_MODIFICATION", "La facture a change."),
    );

    const response = await request(testApp())
      .post("/factures/workflow/42/request-validation")
      .set("Idempotency-Key", "request-validation-attempt-001")
      .send({ expected_version: 1, preview_hash: "a".repeat(64), confirm: true });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      success: false,
      code: "CONCURRENT_MODIFICATION",
    });
    expect(mocks.requestValidation).toHaveBeenCalledWith(expect.objectContaining({
      factureId: 42,
      idempotencyKey: "request-validation-attempt-001",
    }));
  });
});
