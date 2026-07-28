// #210 — Routeur bibliothèque de finitions, monté sur /api/v1/finitions.
// Chaque route déclare sa capacité : refus par défaut, aucun droit implicite.

import { Router } from "express";

import {
  attachRevisionDocument,
  createFinish,
  createRevision,
  getFinish,
  listFinishes,
  listFinishFamilies,
  listRevisionDocuments,
  readCapabilities,
  revisionImpact,
  transitionRevision,
  updateFinish,
  updateRevision,
} from "../controllers/surface-finish.controller";
import { requireSurfaceFinishCapability } from "../middlewares/surface-finish-authorization.middleware";
import {
  attachDocumentBodySchema,
  createFinishBodySchema,
  createRevisionBodySchema,
  listFinishesQuerySchema,
  transitionRevisionBodySchema,
  updateFinishBodySchema,
  updateRevisionBodySchema,
  validate,
} from "../validators/surface-finish.validators";

// `authenticateToken` est déjà appliqué globalement dans v1.routes.ts.
const router = Router();

router.get("/capabilities", readCapabilities);

router.get("/familles", requireSurfaceFinishCapability("library_read"), listFinishFamilies);

router.get(
  "/",
  requireSurfaceFinishCapability("library_read"),
  validate(listFinishesQuerySchema, "query"),
  listFinishes
);

router.post(
  "/",
  requireSurfaceFinishCapability("library_draft_create"),
  validate(createFinishBodySchema),
  createFinish
);

router.get("/:finishId", requireSurfaceFinishCapability("library_read"), getFinish);

router.patch(
  "/:finishId",
  requireSurfaceFinishCapability("library_draft_write"),
  validate(updateFinishBodySchema),
  updateFinish
);

router.post(
  "/:finishId/revisions",
  requireSurfaceFinishCapability("library_draft_write"),
  validate(createRevisionBodySchema),
  createRevision
);

router.patch(
  "/revisions/:revisionId",
  requireSurfaceFinishCapability("library_draft_write"),
  validate(updateRevisionBodySchema),
  updateRevision
);

// La transition affine encore la capacité côté service (soumettre / approuver /
// retirer ne sont pas le même acte).
router.post(
  "/revisions/:revisionId/transition",
  requireSurfaceFinishCapability("library_read"),
  validate(transitionRevisionBodySchema),
  transitionRevision
);

router.get("/revisions/:revisionId/impact", requireSurfaceFinishCapability("library_read"), revisionImpact);

router.get("/revisions/:revisionId/documents", requireSurfaceFinishCapability("documents_read"), listRevisionDocuments);

router.post(
  "/revisions/:revisionId/documents",
  requireSurfaceFinishCapability("documents_write"),
  validate(attachDocumentBodySchema),
  attachRevisionDocument
);

export default router;
