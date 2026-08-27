import type { Request, RequestHandler } from "express";
import type { z } from "zod";

import { HttpError } from "../../utils/httpError";
import {
  repoApproveSupplierInvoice,
  repoDisputeSupplierInvoice,
  repoGetSupplierInvoice,
  repoIdentifySupplierInvoice,
  repoListSupplierInvoices,
  repoMatchSupplierInvoice,
  repoRejectSupplierInvoice,
  repoRequestSupplierInvoiceApproval,
  type SupplierInvoiceActor,
} from "./supplier-invoice.repository";
import {
  supplierInvoiceListQuerySchema,
  supplierInvoiceIdentifyBodySchema,
  supplierInvoiceMatchBodySchema,
  supplierInvoiceParamsSchema,
  supplierInvoiceReasonBodySchema,
  supplierInvoiceVersionBodySchema,
} from "./supplier-invoice.validators";

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(422, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Demande invalide.", parsed.error.flatten());
  }
  return parsed.data;
}

function actorFrom(req: Request): SupplierInvoiceActor {
  if (!req.user) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  const forwarded = req.headers["x-forwarded-for"];
  return {
    userId: req.user.id,
    role: req.user.role ?? null,
    ip: typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() ?? null : req.ip ?? null,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    path: req.originalUrl ?? null,
    pageKey: typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null,
    clientSessionId: typeof req.headers["x-client-session-id"] === "string" ? req.headers["x-client-session-id"] : null,
  };
}

function idempotencyKeyFrom(req: Request): string {
  const value = req.headers["idempotency-key"];
  if (typeof value !== "string" || value.trim().length < 8 || value.trim().length > 200) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "L'en-tête Idempotency-Key (8 à 200 caractères) est obligatoire.");
  }
  return value.trim();
}

export const listSupplierInvoices: RequestHandler = async (req, res, next) => {
  try {
    actorFrom(req);
    res.setHeader("Cache-Control", "no-store, private");
    res.json(await repoListSupplierInvoices(parse(supplierInvoiceListQuerySchema, req.query)));
  } catch (error) { next(error); }
};

export const getSupplierInvoice: RequestHandler = async (req, res, next) => {
  try {
    actorFrom(req);
    const { id } = parse(supplierInvoiceParamsSchema, req.params);
    res.setHeader("Cache-Control", "no-store, private");
    res.json(await repoGetSupplierInvoice(id));
  } catch (error) { next(error); }
};

export const matchSupplierInvoice: RequestHandler = async (req, res, next) => {
  try {
    const { id } = parse(supplierInvoiceParamsSchema, req.params);
    res.json(await repoMatchSupplierInvoice({
      invoiceId: id,
      body: parse(supplierInvoiceMatchBodySchema, req.body),
      actor: actorFrom(req),
      idempotencyKey: idempotencyKeyFrom(req),
    }));
  } catch (error) { next(error); }
};

export const identifySupplierInvoice: RequestHandler = async (req, res, next) => {
  try {
    const { id } = parse(supplierInvoiceParamsSchema, req.params);
    res.json(await repoIdentifySupplierInvoice({
      invoiceId: id,
      body: parse(supplierInvoiceIdentifyBodySchema, req.body),
      actor: actorFrom(req),
      idempotencyKey: idempotencyKeyFrom(req),
    }));
  } catch (error) { next(error); }
};

export const requestSupplierInvoiceApproval: RequestHandler = async (req, res, next) => {
  try {
    const { id } = parse(supplierInvoiceParamsSchema, req.params);
    res.json(await repoRequestSupplierInvoiceApproval({
      invoiceId: id,
      body: parse(supplierInvoiceVersionBodySchema, req.body),
      actor: actorFrom(req),
      idempotencyKey: idempotencyKeyFrom(req),
    }));
  } catch (error) { next(error); }
};

export const approveSupplierInvoice: RequestHandler = async (req, res, next) => {
  try {
    const { id } = parse(supplierInvoiceParamsSchema, req.params);
    res.json(await repoApproveSupplierInvoice({
      invoiceId: id,
      body: parse(supplierInvoiceVersionBodySchema, req.body),
      actor: actorFrom(req),
      idempotencyKey: idempotencyKeyFrom(req),
    }));
  } catch (error) { next(error); }
};

export const disputeSupplierInvoice: RequestHandler = async (req, res, next) => {
  try {
    const { id } = parse(supplierInvoiceParamsSchema, req.params);
    res.json(await repoDisputeSupplierInvoice({
      invoiceId: id,
      body: parse(supplierInvoiceReasonBodySchema, req.body),
      actor: actorFrom(req),
      idempotencyKey: idempotencyKeyFrom(req),
    }));
  } catch (error) { next(error); }
};

export const rejectSupplierInvoice: RequestHandler = async (req, res, next) => {
  try {
    const { id } = parse(supplierInvoiceParamsSchema, req.params);
    res.json(await repoRejectSupplierInvoice({
      invoiceId: id,
      body: parse(supplierInvoiceReasonBodySchema, req.body),
      actor: actorFrom(req),
      idempotencyKey: idempotencyKeyFrom(req),
    }));
  } catch (error) { next(error); }
};
