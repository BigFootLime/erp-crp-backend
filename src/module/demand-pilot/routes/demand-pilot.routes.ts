import {
  batchDecisionSchema,
  decideBatch,
} from "../services/demand-batch-decision.service";
import { asyncHandler } from "../../../utils/asyncHandler";
import { z } from "zod";
import { simulateDemand } from "../services/demand-simulation.service";
import { Router } from "express";
import { createSecureUpload } from "../../../shared/uploads/secure-upload";
import * as controller from "../controllers/demand-pilot.controller";
import { prepareFirmDraft } from "../controllers/demand-pilot-firm-draft.controller";
const router = Router(),
  upload = createSecureUpload("import-tabular", { storage: "memory" });
router.get("/", controller.list);
router.post("/preview", upload.single("file"), controller.previewInternal);
router.post("/imports", controller.importInternal);
router.post("/manual", controller.manual);
router.get("/:id", controller.get);
router.post("/:id/bind-firm", controller.bindFirm);
router.post("/:id/decision", controller.decide);
router.post(
  "/batch-decisions",
  asyncHandler(async (req, res) => {
    res.json(
      await decideBatch(
        batchDecisionSchema.parse(req.body),
        req.user!.id,
        z.string().uuid().parse(req.header("Idempotency-Key")),
      ),
    );
  }),
);
router.post("/firm-drafts", prepareFirmDraft);
router.post(
  "/:id/simulation",
  asyncHandler(async (req, res) => {
    const result = await simulateDemand(
      z.string().trim().min(1).max(80).parse(req.query.client_id),
      z.string().uuid().parse(req.params.id),
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  }),
);
export default router;
