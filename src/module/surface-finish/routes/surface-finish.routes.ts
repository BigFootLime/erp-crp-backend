// #210 — Routeur bibliothèque de finitions, monté sur /api/v1/finitions.
// Chaque route déclare sa capacité : refus par défaut, aucun droit implicite.

import { Router } from "express";

import {
  addFinishFavorite,
  archiveFinish,
  attachRevisionDocument,
  createFinish,
  createRevision,
  getFinish,
  listFinishes,
  listFinishFamilies,
  listFinishHistory,
  listRevisionDocuments,
  listSimilarFinishes,
  reactivateFinish,
  readCapabilities,
  removeFinishFavorite,
  revisionImpact,
  transitionRevision,
  updateFinish,
  updateRevision,
} from "../controllers/surface-finish.controller";
import { requireSurfaceFinishCapability } from "../middlewares/surface-finish-authorization.middleware";
import {
  archiveFinishBodySchema,
  attachDocumentBodySchema,
  createFinishBodySchema,
  createRevisionBodySchema,
  finishHistoryQuerySchema,
  listFinishesQuerySchema,
  reactivateFinishBodySchema,
  similarFinishesQuerySchema,
  transitionRevisionBodySchema,
  updateFinishBodySchema,
  updateRevisionBodySchema,
  validate,
} from "../validators/surface-finish.validators";

// `authenticateToken` est déjà appliqué globalement dans v1.routes.ts.
const router = Router();

router.get("/capabilities", readCapabilities);

router.get("/familles", requireSurfaceFinishCapability("library_read"), listFinishFamilies);

// #226 — Contrôle des doublons. DÉCLARÉ AVANT `/:finishId` : les deux motifs
// n'ont qu'un segment, et Express retient le premier inscrit — placé après,
// cette route serait lue comme une finition d'identifiant « similaires ».
router.get(
  "/similaires",
  requireSurfaceFinishCapability("library_read"),
  validate(similarFinishesQuerySchema, "query"),
  listSimilarFinishes
);

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

// #226 — Favori : préférence personnelle, `library_read` suffit. Exiger un
// droit d'écriture sur le référentiel pour poser une étoile priverait les
// Achats et la production d'un confort qui n'engage rien.
router.post("/:finishId/favori", requireSurfaceFinishCapability("library_read"), addFinishFavorite);
router.delete("/:finishId/favori", requireSurfaceFinishCapability("library_read"), removeFinishFavorite);

// #226 — Archivage. `library_retire` était déclarée depuis #210 sans qu'aucune
// route ne l'impose : c'est ici qu'elle prend enfin son sens.
router.post(
  "/:finishId/archive",
  requireSurfaceFinishCapability("library_retire"),
  validate(archiveFinishBodySchema),
  archiveFinish
);
router.post(
  "/:finishId/reactivate",
  requireSurfaceFinishCapability("library_retire"),
  validate(reactivateFinishBodySchema),
  reactivateFinish
);

// #226 — Historique : lecture d'audit, capacité dédiée.
router.get(
  "/:finishId/historique",
  requireSurfaceFinishCapability("audit_read"),
  validate(finishHistoryQuerySchema, "query"),
  listFinishHistory
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
