import type { Request, RequestHandler } from "express";
import { z } from "zod";

import { HttpError } from "../../../utils/httpError";
import type { AuditContext } from "../../client/repository/client.repository";
import {
  EINVOICE_BILLING_FRAME_CATALOG_VERSION,
  EINVOICE_BILLING_FRAME_CODES,
  EINVOICE_OPERATION_CATEGORIES,
  EINVOICE_TRANSACTION_SCOPES,
} from "./electronic-invoice-regulatory.domain";
import {
  listElectronicInvoiceDirectoryEntries,
  searchElectronicInvoiceDirectoryCompanies,
  verifyElectronicInvoiceDirectoryAddress,
} from "./electronic-invoice-directory.service";
import type { ElectronicInvoiceDirectoryResourceType } from "./electronic-invoice-directory.repository";

const companyQuerySchema = z.object({
  number: z.string().trim().regex(/^\d{9}$/, "SIREN invalide").optional(),
  formal_name_starts_with: z.string().trim().min(2).max(250).optional(),
  post_code_starts_with: z.string().trim().min(2).max(10).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(100),
}).strict().refine(
  (value) => Boolean(value.number || value.formal_name_starts_with || value.post_code_starts_with),
  { message: "Au moins un critère de recherche est requis." }
);

const entriesQuerySchema = z.object({
  number: z.string().trim().regex(/^\d{9}$/, "SIREN invalide"),
}).strict();

const verificationBodySchema = z.object({
  identifier: z.string().trim().regex(/^[A-Za-z0-9]{4}:[^\s\u0000-\u001F\u007F]+$/, "Adresse électronique d'annuaire invalide"),
  expected_updated_at: z.string().datetime({ offset: true }),
}).strict();

function idempotencyKey(req: Request): string {
  const value = req.headers["idempotency-key"];
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < 8 || normalized.length > 200) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key est requis (8 à 200 caractères).");
  }
  return normalized;
}

function auditContext(req: Request): AuditContext {
  if (!req.user || typeof req.user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  const forwarded = req.headers["x-forwarded-for"];
  const forwardedIp = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : null;
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const session = typeof req.headers["x-client-session-id"] === "string"
    ? req.headers["x-client-session-id"]
    : typeof req.headers["x-session-id"] === "string"
      ? req.headers["x-session-id"]
      : null;
  return {
    user_id: req.user.id,
    ip: forwardedIp ?? req.ip ?? null,
    user_agent: userAgent,
    device_type: null,
    os: null,
    browser: null,
    path: (req.originalUrl ?? req.path).split("?")[0] ?? null,
    page_key: typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null,
    client_session_id: session,
  };
}

export const getElectronicInvoiceReferenceData: RequestHandler = (_req, res) => {
  res.json({
    billing_frame_catalog_version: EINVOICE_BILLING_FRAME_CATALOG_VERSION,
    billing_frame_codes: EINVOICE_BILLING_FRAME_CODES,
    operation_categories: EINVOICE_OPERATION_CATEGORIES,
    transaction_scopes: EINVOICE_TRANSACTION_SCOPES,
  });
};

export const searchElectronicInvoiceDirectory: RequestHandler = async (req, res, next) => {
  try {
    const query = companyQuerySchema.parse(req.query);
    res.json(await searchElectronicInvoiceDirectoryCompanies({
      number: query.number,
      formalNameStartsWith: query.formal_name_starts_with,
      postCodeStartsWith: query.post_code_starts_with,
      limit: query.limit,
    }));
  } catch (error) {
    next(error);
  }
};

export const listElectronicInvoiceDirectory: RequestHandler = async (req, res, next) => {
  try {
    const query = entriesQuerySchema.parse(req.query);
    res.json({ data: await listElectronicInvoiceDirectoryEntries(query.number) });
  } catch (error) {
    next(error);
  }
};

function verificationHandler(resourceType: ElectronicInvoiceDirectoryResourceType): RequestHandler {
  return async (req, res, next) => {
    try {
      const rawResourceId = req.params.id;
      const resourceId = typeof rawResourceId === "string" ? rawResourceId.trim() : "";
      if (!resourceId) throw new HttpError(400, "RESOURCE_ID_REQUIRED", "Identifiant du référentiel requis.");
      const body = verificationBodySchema.parse(req.body);
      const result = await verifyElectronicInvoiceDirectoryAddress({
        resourceType,
        resourceId,
        identifier: body.identifier,
        expectedUpdatedAt: body.expected_updated_at,
        idempotencyKey: idempotencyKey(req),
        audit: auditContext(req),
      });
      res.status(result.idempotent_replay ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  };
}

export const verifyClientElectronicInvoiceAddress = verificationHandler("CLIENT");
export const verifyFournisseurElectronicInvoiceAddress = verificationHandler("FOURNISSEUR");
