// GED centrale CERP (ADR-0037) — routeur.
//
// `memoryStorage` et non `dest:` : le fichier est contrôlé (taille, MIME,
// extension, signature) AVANT toute écriture. Aucun octet non validé n'atteint
// le coffre, contrairement aux modules historiques qui écrivent d'abord et
// vérifient ensuite — quand ils vérifient.

import { Router } from "express";
import multer from "multer";

import * as controller from "../controllers/ged.controller";
import { requireGedCapability } from "../middlewares/require-ged-capability";

const router = Router();

// Plafond global du transport. Le plafond RÉEL est celui de la classe
// documentaire, appliqué ensuite par `assertAcceptedFile`.
const MAX_TRANSPORT_BYTES = 512 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TRANSPORT_BYTES, files: 1, fields: 12, fieldSize: 64 * 1024 },
});

/* Référentiel et navigation */
router.get("/classes", requireGedCapability("read"), controller.getClasses);
router.get("/tree", requireGedCapability("read"), controller.getTree);
router.get("/health", requireGedCapability("read"), controller.getVaultStatus);

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
