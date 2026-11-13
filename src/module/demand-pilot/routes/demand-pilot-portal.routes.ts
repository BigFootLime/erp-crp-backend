import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import {
  recordCarco,
  listPortalCarcoDeposits,
  portalCarcoSites,
} from "../services/carco-review.service";
import { requireClientTransactions } from "../../client-portal/domain/transactional-rollout";
import { authenticateClientPortal } from "../../client-portal/middlewares/client-portal-auth.middleware";
import { createSecureUpload } from "../../../shared/uploads/secure-upload";
import * as controller from "../controllers/demand-pilot.controller";
const router = Router(),
  upload = createSecureUpload("import-tabular", { storage: "memory" });
router.use(authenticateClientPortal);
router.use(requireClientTransactions);
router.get(
  "/carco",
  asyncHandler(async (req, res) => {
    const identity = req.portalIdentity!;
    const [items, sites] = await Promise.all([
      listPortalCarcoDeposits(identity.clientId, identity.accountId),
      portalCarcoSites(identity.clientId, identity.accountId),
    ]);
    res.json({ items, sites });
  }),
);
router.post(
  "/carco",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        external_site: z.string().trim().min(1).max(80),
        source_version: z.string().trim().min(1).max(160),
        source_as_of: z.string().datetime({ offset: true }),
        complete_snapshot: z.enum(["true", "false"]).default("false"),
      })
      .strict()
      .parse(req.body);
    if (!req.file)
      throw new HttpError(
        400,
        "CARCO_FILE_REQUIRED",
        "Sélectionnez le carnet Excel ou CSV.",
      );
    const identity = req.portalIdentity!;
    const id = await recordCarco(
      { clientId: identity.clientId, site: input.external_site },
      input.source_version,
      input.source_as_of,
      input.complete_snapshot === "true",
      req.file,
      { portalAccountId: identity.accountId },
    );
    res.json({
      id,
      source_version: input.source_version,
      external_site: input.external_site,
    });
  }),
);
router.get("/", controller.listPortal);
router.post("/preview", upload.single("file"), controller.previewPortal);
router.post("/imports", controller.importPortal);
router.post("/manual", controller.importPortal);
router.get("/:id", controller.getPortal);
router.post("/:id/response", controller.responsePortal);
export default router;
