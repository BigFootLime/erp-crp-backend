import type { Request, RequestHandler } from "express";

import { HttpError } from "../../utils/httpError";
import type { FinanceActorContext } from "../facturation/repository/workflow.repository.shared";
import { accountingExportService } from "./accounting-export.service";
import {
  accountingBatchIdSchema,
  cancelAccountingBatchSchema,
  createAccountingMappingSchema,
  createAccountingPreviewSchema,
  expectedBatchVersionSchema,
  listAccountingMappingsSchema,
  reexportAccountingBatchSchema,
} from "./accounting-export.validators";

function actor(req: Request): FinanceActorContext {
  const userId = req.user?.id;
  if (!Number.isInteger(userId) || !userId || userId <= 0) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return { userId, requestId: req.requestId ?? "missing-request-id", path: req.originalUrl.split("?")[0] ?? req.path };
}

function idempotencyKey(req: Request): string | undefined {
  return req.get("Idempotency-Key") ?? undefined;
}

function batchId(req: Request): string {
  return accountingBatchIdSchema.parse(req.params.id);
}

export const listAccountingMappings: RequestHandler = async (req, res, next) => {
  try { actor(req); const query = listAccountingMappingsSchema.parse(req.query); res.json({ items: await accountingExportService.listMappings(query.include_retired) }); } catch (error) { next(error); }
};
export const createAccountingMapping: RequestHandler = async (req, res, next) => {
  try { res.status(201).json(await accountingExportService.createMapping({ input: createAccountingMappingSchema.parse(req.body), actor: actor(req), idempotencyKey: idempotencyKey(req) })); } catch (error) { next(error); }
};
export const listAccountingBatches: RequestHandler = async (req, res, next) => {
  try { actor(req); res.json({ items: await accountingExportService.listBatches() }); } catch (error) { next(error); }
};
export const getAccountingBatch: RequestHandler = async (req, res, next) => {
  try { actor(req); res.json(await accountingExportService.getBatch(batchId(req))); } catch (error) { next(error); }
};
export const previewAccountingBatch: RequestHandler = async (req, res, next) => {
  try { res.status(201).json(await accountingExportService.preview({ input: createAccountingPreviewSchema.parse(req.body), actor: actor(req), idempotencyKey: idempotencyKey(req) })); } catch (error) { next(error); }
};
export const validateAccountingBatch: RequestHandler = async (req, res, next) => {
  try { res.json(await accountingExportService.validate({ batchId: batchId(req), body: expectedBatchVersionSchema.parse(req.body), actor: actor(req), idempotencyKey: idempotencyKey(req) })); } catch (error) { next(error); }
};
export const generateAccountingBatch: RequestHandler = async (req, res, next) => {
  try { res.json(await accountingExportService.generate({ batchId: batchId(req), body: expectedBatchVersionSchema.parse(req.body), actor: actor(req), idempotencyKey: idempotencyKey(req) })); } catch (error) { next(error); }
};
export const cancelAccountingBatch: RequestHandler = async (req, res, next) => {
  try { res.json(await accountingExportService.cancel({ batchId: batchId(req), body: cancelAccountingBatchSchema.parse(req.body), actor: actor(req), idempotencyKey: idempotencyKey(req) })); } catch (error) { next(error); }
};
export const reexportAccountingBatch: RequestHandler = async (req, res, next) => {
  try { res.status(201).json(await accountingExportService.reexport({ batchId: batchId(req), body: reexportAccountingBatchSchema.parse(req.body), actor: actor(req), idempotencyKey: idempotencyKey(req) })); } catch (error) { next(error); }
};
export const downloadAccountingArtifact: RequestHandler = async (req, res, next) => {
  try {
    actor(req);
    const artifact = await accountingExportService.download(batchId(req));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${artifact.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    res.setHeader("Digest", `sha-256=${Buffer.from(artifact.sha256, "hex").toString("base64")}`);
    res.send(artifact.content);
  } catch (error) { next(error); }
};
