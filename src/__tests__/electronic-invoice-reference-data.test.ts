import { ALL_FIXTURE_SENSITIVE_RIGHTS, attachSensitiveAccountFixture } from "./helpers/sensitive-account-fixture";
vi.mock("../module/access-control/repository/sensitive-capabilities.repository", async () => ({ repoAccountSensitiveCapabilities: (await import("./helpers/sensitive-account-fixture")).readSensitiveAccountFixture }));
import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const directory = vi.hoisted(() => ({
  list: vi.fn(),
  search: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("../module/facturation/electronic-invoicing/electronic-invoice-directory.service", () => ({
  listElectronicInvoiceDirectoryEntries: directory.list,
  searchElectronicInvoiceDirectoryCompanies: directory.search,
  verifyElectronicInvoiceDirectoryAddress: directory.verify,
}));

import { errorHandler } from "../middlewares/errorHandler";
import electronicInvoiceDirectoryRoutes from "../module/facturation/electronic-invoicing/electronic-invoice-directory.routes";
import facturesRoutes from "../module/facturation/routes/factures.routes";
import { validationErrorMiddleware } from "../module/auth/middlewares/validationError.middleware";
import {
  EINVOICE_BILLING_FRAME_CATALOG_VERSION,
  EINVOICE_BILLING_FRAME_CODES,
  EINVOICE_BILLING_FRAMES,
  EINVOICE_OPERATION_CATEGORIES,
  EINVOICE_TRANSACTION_SCOPES,
} from "../module/facturation/electronic-invoicing/electronic-invoice-regulatory.domain";

// Public response contract consumed by facture-workflow.schema.ts in the web app.
// An HTTP 200 with string-only codes must fail before the user can qualify a draft.
const webReferenceDataContract = z.object({
  billing_frame_catalog_version: z.string().min(1),
  billing_frame_codes: z.array(z.object({
    code: z.string().min(1),
    operationCategory: z.enum(EINVOICE_OPERATION_CATEGORIES),
    labelFr: z.string().min(1),
  })),
  operation_categories: z.array(z.enum(EINVOICE_OPERATION_CATEGORIES)),
  transaction_scopes: z.array(z.enum(EINVOICE_TRANSACTION_SCOPES)),
});

function app(role?: string, rights: ReadonlyArray<(typeof ALL_FIXTURE_SENSITIVE_RIGHTS)[number]> = []) {
  const server = express();
  server.use(express.json());
  server.use(((req, _res, next) => {
    if (role) req.user = { id: 7, username: "recipe", email: "recipe@test.invalid", role };
    attachSensitiveAccountFixture(req, rights);
    next();
  }) as RequestHandler);
  server.use("/electronic-invoicing", electronicInvoiceDirectoryRoutes);
  server.use("/factures", facturesRoutes);
  server.use(validationErrorMiddleware);
  server.use(errorHandler);
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("issuer routing qualification permissions", () => {
  const route = "/factures/configuration/issuers/b7c1e5a2-3f4d-4e8b-9a06-380569012000/electronic-invoicing/verify";
  const body = { identifier: "0225:999999998", expected_updated_at: "2026-10-11T12:00:00Z" };
  it.each([undefined, "Comptable", "Operateur"])("refuses a caller without Finance settings rights (%s)", async (role) => {
    const response = await request(app(role)).post(route).set("Idempotency-Key", "issuer-test-1219").send(body);
    expect(response.status).toBe(role ? 403 : 401);
    expect(directory.verify).not.toHaveBeenCalled();
  });
  it("qualifies only through the service with the authenticated administrator and replay key", async () => {
    directory.verify.mockResolvedValue({ idempotent_replay: false, resource_type: "ISSUER" });
    const response = await request(app("Administrateur Systeme et Reseau", ALL_FIXTURE_SENSITIVE_RIGHTS)).post(route).set("Idempotency-Key", "issuer-test-1219").send(body);
    expect(response.status).toBe(201);
    expect(directory.verify).toHaveBeenCalledWith(expect.objectContaining({ resourceType: "ISSUER", identifier: body.identifier, idempotencyKey: "issuer-test-1219", audit: expect.objectContaining({ user_id: 7 }) }));
  });
  it("refuses a missing replay key before querying the directory", async () => {
    const response = await request(app("Directeur", ALL_FIXTURE_SENSITIVE_RIGHTS)).post(route).send(body);
    expect(response.status).toBe(400); expect(directory.verify).not.toHaveBeenCalled();
  });
});

describe("electronic invoice reference-data HTTP contract (OBS059)", () => {
  it("provides every qualified billing frame with its server category and French label", async () => {
    const response = await request(app("Comptable")).get("/electronic-invoicing/reference-data");
    expect(response.status).toBe(200);
    const data = webReferenceDataContract.parse(response.body);
    expect(data.billing_frame_catalog_version).toBe(EINVOICE_BILLING_FRAME_CATALOG_VERSION);
    expect(data.billing_frame_codes.map((frame) => frame.code)).toEqual(EINVOICE_BILLING_FRAME_CODES);
    for (const [index, code] of EINVOICE_BILLING_FRAME_CODES.entries()) {
      expect(data.billing_frame_codes[index]).toEqual({
        code,
        operationCategory: EINVOICE_BILLING_FRAMES[code].operationCategory,
        labelFr: EINVOICE_BILLING_FRAMES[code].label,
      });
    }
    expect(data.operation_categories).toEqual(EINVOICE_OPERATION_CATEGORIES);
    expect(data.transaction_scopes).toEqual(EINVOICE_TRANSACTION_SCOPES);
    for (const call of Object.values(directory)) expect(call).not.toHaveBeenCalled();
  });

  it("allows the existing technical-administrator read capability without directory lookup", async () => {
    const response = await request(app("Administrateur Systeme et Reseau", ALL_FIXTURE_SENSITIVE_RIGHTS))
      .get("/electronic-invoicing/reference-data");
    expect(response.status).toBe(200);
    expect(webReferenceDataContract.safeParse(response.body).success).toBe(true);
    for (const call of Object.values(directory)) expect(call).not.toHaveBeenCalled();
  });

  it("requires an authenticated caller", async () => {
    const response = await request(app()).get("/electronic-invoicing/reference-data");
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHORIZED");
    expect(response.body).not.toHaveProperty("billing_frame_codes");
  });

  it("keeps the existing Finance read permission required", async () => {
    const response = await request(app("Operateur"))
      .get("/electronic-invoicing/reference-data");
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FINANCE_CAPABILITY_REQUIRED");
    expect(response.body).not.toHaveProperty("billing_frame_codes");
  });
});
