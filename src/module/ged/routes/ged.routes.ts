// GED centrale CERP (ADR-0037) — routeur.
//
// Le transport GED est toujours stagé sur disque : un document de 512 Mio ne
// doit jamais devenir un Buffer Node. Validation, scan, empreinte et promotion
// dans le coffre travaillent ensuite par flux bornés.

import { Router } from "express";

import * as controller from "../controllers/ged.controller";
import { requireGedCapability } from "../middlewares/require-ged-capability";
import { createSecureUpload } from "../../../shared/uploads/secure-upload";
import { requireCutoverParentAccess } from "../middlewares/require-cutover-parent-access";

const router = Router();

// Plafond global du transport. Le plafond RÉEL est celui de la classe
// documentaire, appliqué ensuite par `assertAcceptedFile`.
const upload = createSecureUpload("ged-deferred", { storage: "staging", scan: "deferred" });

/* Référentiel et navigation */
router.get("/classes", requireGedCapability("read"), controller.getClasses);
router.get("/tree", requireGedCapability("read"), controller.getTree);
router.get("/health", requireGedCapability("read"), controller.getVaultStatus);
router.get("/quarantine", requireGedCapability("admin"), controller.listQuarantine);
router.post("/quarantine/:sessionId/rescan", requireGedCapability("admin"), controller.rescanQuarantine);
router.post("/quarantine/:sessionId/release", requireGedCapability("admin"), controller.releaseQuarantine);
router.delete("/quarantine/:sessionId", requireGedCapability("admin"), controller.deleteQuarantine);

/* Documents */
router.get("/piece-revisions/:revisionId/reusable-documents", requireGedCapability("upload"), controller.listReusableRevisionDocuments);
router.post("/documents/:id/revision-links", requireGedCapability("upload"), requireCutoverParentAccess, controller.reuseRevisionDocument);
router.get("/documents", requireGedCapability("read"), controller.listDocuments);
router.post("/documents", requireGedCapability("upload"), upload.single("file"), controller.postDocument);
router.get("/documents/:id", requireGedCapability("read"), requireCutoverParentAccess, controller.getDocument);
router.get("/documents/:id/history", requireGedCapability("read"), requireCutoverParentAccess, controller.getDocumentHistory);
router.post(
  "/documents/:id/versions",
  requireGedCapability("upload"),
  requireCutoverParentAccess,
  upload.single("file"),
  controller.postDocumentVersion
);

/* Cycle de vie */
router.post("/versions/:versionId/submit", requireGedCapability("submit"), requireCutoverParentAccess, controller.submitVersion);
router.post("/versions/:versionId/approve", requireGedCapability("approve"), requireCutoverParentAccess, controller.approveVersion);
router.post("/versions/:versionId/publish", requireGedCapability("publish"), requireCutoverParentAccess, controller.publishVersion);
router.post("/versions/:versionId/obsolete", requireGedCapability("obsolete"), requireCutoverParentAccess, controller.obsoleteVersion);

/* Contenu */
router.get("/versions/:versionId/content", requireGedCapability("download"), requireCutoverParentAccess, controller.downloadVersion);

export default router;
