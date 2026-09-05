import { svcProductionWorkbenchConfig } from "../services/production-workbench.service";
import { z } from "zod";
import { svcSynchronizePreparationChildren } from "../services/production-workbench.service";
import { stockReuseSchema } from "../validators/production-workbench.validators";
import { svcReusePreparationStock } from "../services/production-workbench.service";
import {
  programmingTaskSchema,
  importPurchasesSchema,
} from "../validators/production-workbench.validators";
import {
  svcSaveProgrammingTask,
  svcImportPreparationPurchases,
} from "../services/production-workbench.service";
import {
  consolidationSchema,
  createConsolidationSchema,
  dissolveConsolidationSchema,
} from "../validators/production-workbench.validators";
import {
  svcPreviewConsolidation,
  svcCreateConsolidation,
  svcGetConsolidation,
  svcDissolveConsolidation,
} from "../services/production-workbench.service";
import { asyncHandler } from "../../../utils/asyncHandler";
import { buildAuditContext } from "./production.controller";
import { ofIdParamSchema } from "../validators/production.validators";
import {
  worklistQuerySchema,
  preparationReviewSchema,
  preparationVersionSchema,
  savePreparationDecisionsSchema,
} from "../validators/production-workbench.validators";
import {
  svcProductionWorklist,
  svcPreparationWorkbench,
  svcReviewPreparationStock,
  svcSavePreparationDecisions,
  svcSelectPreparationVersion,
  svcGenerateSelfInspection,
  svcDownloadSelfInspection,
} from "../services/production-workbench.service";

export const synchronizePreparationChildren = asyncHandler(async (req, res) => {
  res.json(
    await svcSynchronizePreparationChildren(
      ofIdParamSchema.parse({ params: req.params }).params.id,
      z
        .object({ expected_updated_at: z.string().min(1) })
        .strict()
        .parse(req.body).expected_updated_at,
      buildAuditContext(req),
    ),
  );
});
export const reusePreparationStock = asyncHandler(async (req, res) => {
  res.json(
    await svcReusePreparationStock(
      ofIdParamSchema.parse({ params: req.params }).params.id,
      stockReuseSchema.parse(req.body),
      buildAuditContext(req),
    ),
  );
});
export const saveProgrammingTask = asyncHandler(async (req, res) => {
  res.json(
    await svcSaveProgrammingTask(
      ofIdParamSchema.parse({ params: req.params }).params.id,
      programmingTaskSchema.parse(req.body),
      buildAuditContext(req),
    ),
  );
});
export const importPreparationPurchases = asyncHandler(async (req, res) => {
  res.json(
    await svcImportPreparationPurchases(
      ofIdParamSchema.parse({ params: req.params }).params.id,
      importPurchasesSchema.parse(req.body),
      buildAuditContext(req),
    ),
  );
});
export const productionWorklist = asyncHandler(async (req, res) => {
  res.json(await svcProductionWorklist(worklistQuerySchema.parse(req.query)));
});
export const previewConsolidation = asyncHandler(async (req, res) => {
  res.json(await svcPreviewConsolidation(consolidationSchema.parse(req.body)));
});
export const createConsolidation = asyncHandler(async (req, res) => {
  res
    .status(201)
    .json(
      await svcCreateConsolidation(
        createConsolidationSchema.parse(req.body),
        buildAuditContext(req),
      ),
    );
});
export const getConsolidation = asyncHandler(async (req, res) => {
  res.json(await svcGetConsolidation(z.string().uuid().parse(req.params.id)));
});
export const dissolveConsolidation = asyncHandler(async (req, res) => {
  res.json(
    await svcDissolveConsolidation(
      z.string().uuid().parse(req.params.id),
      dissolveConsolidationSchema.parse(req.body),
      buildAuditContext(req),
    ),
  );
});
export const preparationWorkbench = asyncHandler(async (req, res) => {
  res.json(
    await svcPreparationWorkbench(
      ofIdParamSchema.parse({ params: req.params }).params.id,
    ),
  );
});
export const savePreparationDecisions = asyncHandler(async (req, res) => {
  res.json(
    await svcSavePreparationDecisions(
      ofIdParamSchema.parse({ params: req.params }).params.id,
      savePreparationDecisionsSchema.parse(req.body),
      buildAuditContext(req),
    ),
  );
});
export const selectPreparationVersion = asyncHandler(async (req, res) => {
  res.json(
    await svcSelectPreparationVersion(
      ofIdParamSchema.parse({ params: req.params }).params.id,
      preparationVersionSchema.parse(req.body),
      buildAuditContext(req),
    ),
  );
});
export const reviewPreparationStock = asyncHandler(async (req, res) => {
  res.json(
    await svcReviewPreparationStock(
      ofIdParamSchema.parse({ params: req.params }).params.id,
      preparationReviewSchema.parse(req.body),
      buildAuditContext(req),
    ),
  );
});
export const generateSelfInspection = asyncHandler(async (req, res) => {
  const body = z
    .object({ expected_updated_at: z.string().min(1) })
    .strict()
    .parse(req.body);
  res.json(
    await svcGenerateSelfInspection(
      ofIdParamSchema.parse({ params: req.params }).params.id,
      body.expected_updated_at,
      buildAuditContext(req),
    ),
  );
});
export const downloadSelfInspection = asyncHandler(async (req, res) => {
  const params = z
    .object({
      id: z.coerce.number().int().positive(),
      sheetId: z.string().uuid(),
    })
    .parse(req.params);
  const pdf = await svcDownloadSelfInspection(
    params.id,
    params.sheetId,
    buildAuditContext(req),
  );
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="autocontrole-OF-${params.id}.pdf"`,
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(pdf);
});

export const productionWorkbenchConfig = asyncHandler(async (_req, res) => {
  res.json(await svcProductionWorkbenchConfig());
});
