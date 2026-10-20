import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import { CUTOVER_CONTRIBUTABLE_DOMAINS } from "../domain/cutover-catalog";
import { getCutoverCapabilities } from "../services/data-cutover.service";
import * as repository from "../repository/data-cutover.repository";
import type { CutoverAccess } from "../types/data-cutover.types";
import { CUTOVER_DOMAINS } from "../types/data-cutover.types";
import { applicationApplySchema, applicationPreviewSchema, createCutoverBatchSchema, cutoverIdempotencyKey, cutoverUuid, listCutoverRowsSchema, patchCutoverRowSchema, previewCutoverSchema, validateCutoverSchema } from "../validators/data-cutover.validators";
import { cutoverApplication } from "../application/application.registry";

const access = (res: Response): CutoverAccess => res.locals.cutoverAccess as CutoverAccess;
const key = (req: Request) => cutoverIdempotencyKey.parse(req.get("Idempotency-Key"));
const handler = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => {
  void fn(req, res).catch((error: unknown) => next(error instanceof z.ZodError
    ? new HttpError(422, "CUTOVER_INVALID_INPUT", "Le format de certains champs est incorrect. Corrigez les champs indiqués avant de continuer.", { issues: error.issues.slice(0, 30).map((issue) => ({ field: issue.path.join("."), message: issue.message })) })
    : error));
};

export const capabilities = handler(async (_req, res) => res.json(await getCutoverCapabilities(access(res))));
export const lookup = handler(async (req, res) => {
  const entity = z.enum(["CUSTOMER", "SUPPLIER", "ARTICLE", "TECHNICAL_PIECE", "CONTRACT"]).parse(req.params.entity);
  const query = z.object({ search: z.string().trim().min(2).max(80) }).strict().parse(req.query);
  res.json(await repository.repoCutoverLookup(entity, query.search));
});
export const list = handler(async (_req, res) => res.json(await repository.repoListCutoverBatches(access(res))));
export const detail = handler(async (req, res) => res.json(await repository.repoGetCutoverBatch(cutoverUuid.parse(req.params.id), access(res))));
export const rows = handler(async (req, res) => res.json(await repository.repoGetCutoverRows(cutoverUuid.parse(req.params.id), listCutoverRowsSchema.parse(req.query), access(res))));
export const create = handler(async (req, res) => res.status(201).json(await repository.repoCreateCutoverBatch(createCutoverBatchSchema.parse(req.body), access(res).userId, key(req))));
export const patchRow = handler(async (req, res) => res.json(await repository.repoPatchCutoverRow(cutoverUuid.parse(req.params.id), cutoverUuid.parse(req.params.rowId), patchCutoverRowSchema.parse(req.body), access(res), key(req))));
export const preview = handler(async (req, res) => res.json(await repository.repoPreviewCutover(cutoverUuid.parse(req.params.id), previewCutoverSchema.parse(req.body), access(res).userId, key(req))));
export const validate = handler(async (req, res) => res.json(await repository.repoValidateCutover(cutoverUuid.parse(req.params.id), validateCutoverSchema.parse(req.body), access(res).userId, key(req))));
export const exportPackage = handler(async (req, res) => {
  const id = cutoverUuid.parse(req.params.id);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Disposition", `attachment; filename="CERP-reprise-${id}.json"`);
  res.json(await repository.repoExportCutover(id));
});
export const contributors = handler(async (req, res) => res.json(await repository.repoGetCutoverContributors(cutoverUuid.parse(req.params.id))));
export const assignContributor = handler(async (req, res) => {
  const input = z.object({ user_id: z.number().int().positive(), domains: z.array(z.enum(CUTOVER_DOMAINS).refine((domain) => CUTOVER_CONTRIBUTABLE_DOMAINS.includes(domain), "Les soldes, documents financiers et rapprochements de comptes restent réservés au SuperAdmin." )).max(CUTOVER_CONTRIBUTABLE_DOMAINS.length).refine((domains) => new Set(domains).size === domains.length, "Domaines dupliqués.") }).strict().parse(req.body);
  res.json(await repository.repoAssignCutoverContributor(cutoverUuid.parse(req.params.id), input, access(res).userId, key(req)));
});

export const applicationPreview = handler(async (req, res) => {
  const input = applicationPreviewSchema.parse(req.body);
  res.json(await cutoverApplication.preview(cutoverUuid.parse(req.params.id), input.expected_version, access(res).userId));
});
export const apply = handler(async (req, res) => {
  const correlationId = typeof res.locals.correlationId === "string" ? res.locals.correlationId : key(req);
  res.json(await cutoverApplication.apply(cutoverUuid.parse(req.params.id), applicationApplySchema.parse(req.body), access(res).userId, key(req), correlationId));
});
export const applications = handler(async (req, res) => {
  const id = cutoverUuid.parse(req.params.id);
  await repository.repoGetCutoverBatch(id, access(res));
  res.json(await cutoverApplication.list(id));
});
export const openings = handler(async (req, res) => res.json(await repository.repoListCutoverOpenings(cutoverUuid.parse(req.params.id))));
export const evidence = handler(async (req, res) => res.json(await repository.repoListCutoverEvidence(cutoverUuid.parse(req.params.id))));
export const linkEvidence = handler(async (req, res) => {
  const input = z.object({ expected_version: z.number().int().positive(), field_key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), ged_document_id: cutoverUuid }).strict().parse(req.body);
  res.json(await repository.repoLinkCutoverEvidence(cutoverUuid.parse(req.params.id), cutoverUuid.parse(req.params.rowId), input, access(res).userId, key(req)));
});
