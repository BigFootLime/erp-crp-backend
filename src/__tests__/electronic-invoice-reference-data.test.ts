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

function app(role?: string) {
  const server = express();
  server.use(((req, _res, next) => {
    if (role) req.user = { id: 7, username: "recipe", email: "recipe@test.invalid", role };
    next();
  }) as RequestHandler);
  server.use("/electronic-invoicing", electronicInvoiceDirectoryRoutes);
  server.use(errorHandler);
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
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
    const response = await request(app("Administrateur Systeme et Reseau"))
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
