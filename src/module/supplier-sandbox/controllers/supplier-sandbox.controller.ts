import type { RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import * as service from "../services/supplier-sandbox.service";
import {
  supplierSandboxLoginSchema,
  supplierSandboxPromiseSchema,
} from "../validators/supplier-sandbox.validators";
const identity = (req: Parameters<RequestHandler>[0]) => {
  if (!req.supplierSandboxIdentity)
    throw new HttpError(
      401,
      "SUPPLIER_SANDBOX_SESSION_REQUIRED",
      "Session fournisseur requise.",
    );
  return req.supplierSandboxIdentity;
};
const key = (req: Parameters<RequestHandler>[0]) => {
  const v = req.header("Idempotency-Key")?.trim();
  if (!v || v.length < 8 || v.length > 120)
    throw new HttpError(
      400,
      "SUPPLIER_SANDBOX_IDEMPOTENCY_REQUIRED",
      "Une clé d'idempotence est requise.",
    );
  return v;
};
export const login: RequestHandler = async (req, res, next) => {
  try {
    res.json(
      await service.loginSupplierSandbox(
        supplierSandboxLoginSchema.parse(req.body),
      ),
    );
  } catch (e) {
    next(e);
  }
};
export const lines: RequestHandler = async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ data: await service.listSupplierSandboxLines(identity(req)) });
  } catch (e) {
    next(e);
  }
};
export const proposePromise: RequestHandler = async (req, res, next) => {
  try {
    const out = await service.submitSupplierSandboxPromise(
      identity(req),
      supplierSandboxPromiseSchema.parse(req.body),
      key(req),
    );
    res.status(out.replayed ? 200 : 201).json(out);
  } catch (e) {
    next(e);
  }
};
