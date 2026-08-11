// GED centrale CERP (ADR-0037) — routeur.
//
// Le transport GED est toujours stagé sur disque : un document de 512 Mio ne
// doit jamais devenir un Buffer Node. Validation, scan, empreinte et promotion
// dans le coffre travaillent ensuite par flux bornés.

import { Router } from "express";

import * as controller from "../controllers/ged.controller";
import { requireGedCapability } from "../middlewares/require-ged-capability";
import { createSecureUpload } from "../../../shared/uploads/secure-upload";

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
router.get("/documents", requireGedCapability("read"), controller.listDocuments);
router.post("/documents", requireGedCapability("upload"), upload.single("file"), controller.postDocument);
router.get("/documents/:id", requireGedCapability("read"), controller.getDocument);
router.get("/documents/:id/history", requireGedCapability("read"), controller.getDocumentHistory);
router.post(
  "/documents/:id/versions",
  requireGedCapability("upload"),
  upload.single("file"),
  controller.postDocumentVersion
);

/* Cycle de vie */
router.post("/versions/:versionId/submit", requireGedCapability("submit"), controller.submitVersion);
router.post("/versions/:versionId/approve", requireGedCapability("approve"), controller.approveVersion);
router.post("/versions/:versionId/publish", requireGedCapability("publish"), controller.publishVersion);
router.post("/versions/:versionId/obsolete", requireGedCapability("obsolete"), controller.obsoleteVersion);

/* Contenu */
router.get("/versions/:versionId/content", requireGedCapability("download"), controller.downloadVersion);

export default router;
