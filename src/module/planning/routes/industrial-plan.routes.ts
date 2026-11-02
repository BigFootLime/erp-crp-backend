import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../utils/asyncHandler";
import { requireSuperadmin } from "../../access-control/middlewares/require-superadmin";
import { requirePlanningCapability } from "../middlewares/planning-authorization.middleware";
import {
  industrialClient,
  industrialPolicySchema,
  industrialRunSchema,
  industrialSettingsSchema,
} from "../validators/industrial-plan.validators";
import {
  enqueueIndustrialRun,
  industrialRunById,
  industrialTx,
  listIndustrialRuns,
  validateIndustrialRun,
} from "../services/industrial-runs.service";
import {
  readIndustrialPolicy,
  setIndustrialPolicy,
} from "../repository/industrial-policy.repository";
import {
  getIndustrialSettings,
  updateIndustrialSettings,
} from "../repository/industrial-settings.repository";
import { industrialExecutionSchema } from "../validators/industrial-execution.validators";
import { executeIndustrialProposals } from "../services/industrial-proposal-execution.service";
import { buildAuditContext } from "../controllers/planning.controller";
import { saveArticleMapping } from "../../demand-pilot/repository/demand-mapping.repository";
import {
  targetSchema,
  savePicTarget,
  readPicTargets,
} from "../repository/industrial-targets.repository";
import { industrialDate } from "../validators/industrial-plan.validators";
const router = Router();
router.get(
  "/pic-targets",
  requirePlanningCapability("read_capacity"),
  asyncHandler(async (req, res) => {
    res.json({
      items: await industrialTx((tx) =>
        readPicTargets(
          tx,
          industrialClient.parse(req.query.client_id),
          industrialDate.parse(req.query.start),
          18,
        ),
      ),
    });
  }),
);
router.put(
  "/pic-targets",
  requireSuperadmin,
  asyncHandler(async (req, res) => {
    res.json(
      await industrialTx((tx) =>
        savePicTarget(tx, req.user!.id, targetSchema.parse(req.body)),
      ),
    );
  }),
);
const mapping = z
  .object({
    client_id: industrialClient,
    external_code: z.string().trim().min(1).max(160),
    external_unit: z.string().trim().min(1).max(32),
    article_id: z.string().uuid(),
    units_per_external: z.number().positive().max(1e9),
  })
  .strict();
router.get(
  "/article-mappings",
  requirePlanningCapability("read_capacity"),
  asyncHandler(async (req, res) => {
    const id = industrialClient.parse(req.query.client_id);
    res.json({
      items: await industrialTx(
        async (tx) =>
          (
            await tx.query(
              "SELECT external_code,external_unit,article_id,units_per_external::float8 FROM public.demand_pilot_article_mappings WHERE client_id=$1 ORDER BY external_code,external_unit",
              [id],
            )
          ).rows,
      ),
    });
  }),
);
router.put(
  "/article-mappings",
  requireSuperadmin,
  asyncHandler(async (req, res) => {
    res.json(
      await industrialTx((tx) =>
        saveArticleMapping(tx, mapping.parse(req.body), req.user!.id),
      ),
    );
  }),
);
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.get(
  "/runs",
  requirePlanningCapability("read_capacity"),
  asyncHandler(async (req, res) => {
    res.json(
      await listIndustrialRuns(industrialClient.parse(req.query.client_id)),
    );
  }),
);
router.post(
  "/runs",
  requirePlanningCapability("manage_schedule"),
  asyncHandler(async (req, res) => {
    res
      .status(202)
      .json(
        await enqueueIndustrialRun(
          industrialRunSchema.parse(req.body),
          req.user!.id,
        ),
      );
  }),
);
router.get(
  "/runs/:id",
  requirePlanningCapability("read_capacity"),
  asyncHandler(async (req, res) => {
    res.json(await industrialRunById(z.string().uuid().parse(req.params.id)));
  }),
);
router.post(
  "/runs/:id/validate",
  requirePlanningCapability("manage_schedule"),
  asyncHandler(async (req, res) => {
    res.json(
      await validateIndustrialRun(
        z.string().uuid().parse(req.params.id),
        req.user!.id,
      ),
    );
  }),
);
router.post(
  "/runs/:id/proposals/execute",
  requirePlanningCapability("supervise_execution"),
  asyncHandler(async (req, res) => {
    res.json(
      await executeIndustrialProposals(
        z.string().uuid().parse(req.params.id),
        industrialExecutionSchema.parse(req.body),
        buildAuditContext(req),
      ),
    );
  }),
);
router.get(
  "/policy",
  requirePlanningCapability("read_capacity"),
  asyncHandler(async (req, res) => {
    res.json(
      await industrialTx((tx) =>
        readIndustrialPolicy(tx, industrialClient.parse(req.query.client_id)),
      ),
    );
  }),
);
router.put(
  "/policy",
  requireSuperadmin,
  asyncHandler(async (req, res) => {
    res.json(
      await industrialTx((tx) =>
        setIndustrialPolicy(
          tx,
          req.user!.id,
          industrialPolicySchema.parse(req.body),
        ),
      ),
    );
  }),
);
router.get(
  "/settings",
  requirePlanningCapability("read_capacity"),
  asyncHandler(async (req, res) => {
    res.json(
      await industrialTx((tx) =>
        getIndustrialSettings(tx, industrialClient.parse(req.query.client_id)),
      ),
    );
  }),
);
router.put(
  "/settings",
  requireSuperadmin,
  asyncHandler(async (req, res) => {
    res.json(
      await industrialTx((tx) =>
        updateIndustrialSettings(
          tx,
          req.user!.id,
          industrialSettingsSchema.parse(req.body),
        ),
      ),
    );
  }),
);
export default router;
