import { Router } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import {
  requireIdempotencyKey,
  requireOfCapability,
} from "../middlewares/of-versioning-authorization.middleware";
import {
  assessVariance,
  capabilities,
  compareRevisions,
  createArDossier,
  createPlanningDraft,
  createProposal,
  createRevision,
  createVisa,
  emitDocument,
  getRevision,
  listArDossiers,
  listDocuments,
  listMachineFamilies,
  listPlanningVersions,
  listProposals,
  listRevisions,
  previewPayload,
  previewPdf,
  refusePlanning,
  reprintDocument,
  resolveProposal,
  submitPlanning,
  updateArDossier,
  validatePlanning,
} from "../controllers/of-versioning.controller";

/**
 * Surface « OF : versioning, replanification, AR client et document » (#370),
 * montée sous `/production/of-versioning`.
 *
 * Aucune garde globale trop large : chaque route déclare sa capacité fine, refus
 * par défaut. Le routeur historique `production.routes.ts` reste intact pour ne
 * casser aucun écran en production.
 *
 * Les commandes à effet exigent `Idempotency-Key`. Les lectures et les aperçus
 * n'en exigent aucune : ils n'écrivent rien.
 */
const router = Router();
router.use(authenticateToken);

/* ------------------------------ Référentiels ------------------------------ */

router.get("/capabilities", capabilities);
router.get("/machine-families", requireOfCapability("read"), listMachineFamilies);

/* -------------------------------- AR client ------------------------------- */
// Déclaré AVANT les routes `/:ofId/...` : sans cela, « ar-dossiers » serait
// capturé comme un `ofId` et la validation renverrait un 400 illisible.

router.get("/ar-dossiers", requireOfCapability("ar_recalage"), listArDossiers);
router.patch("/ar-dossiers/:dossierId", requireOfCapability("ar_recalage"), updateArDossier);

/* -------------------------------- Révisions ------------------------------- */

router.get("/:ofId/revisions", requireOfCapability("read"), listRevisions);
router.get("/:ofId/revisions/compare", requireOfCapability("read"), compareRevisions);
router.get("/:ofId/revisions/:revisionId", requireOfCapability("read"), getRevision);

// Créer une révision n'écrase jamais la précédente : elle recopie ses opérations
// et applique les modifications sur le nouveau jeu.
router.post(
  "/:ofId/revisions",
  requireIdempotencyKey,
  requireOfCapability("revise"),
  createRevision
);

/* ---------------------------------- VISA ---------------------------------- */

router.post(
  "/:ofId/revisions/:revisionId/visas",
  requireIdempotencyKey,
  requireOfCapability("visa"),
  createVisa
);

/* ----------------------------- Dérive de temps ---------------------------- */

// Évaluation seule : lecture, aucun effet. Permet à l'UI d'afficher le verdict
// du seuil avant de proposer quoi que ce soit.
router.post("/:ofId/time-variance/assess", requireOfCapability("plan_draft"), assessVariance);

router.get("/:ofId/time-variance", requireOfCapability("read"), listProposals);
router.post(
  "/:ofId/time-variance",
  requireIdempotencyKey,
  requireOfCapability("plan_draft"),
  createProposal
);
router.post(
  "/:ofId/time-variance/:proposalId/resolve",
  requireOfCapability("plan_validate"),
  resolveProposal
);

/* -------------------------------- Planning -------------------------------- */

router.get("/:ofId/planning-versions", requireOfCapability("read"), listPlanningVersions);

// Un brouillon ne modifie RIEN dans le planning actif : capacité large.
router.post(
  "/:ofId/planning-versions",
  requireIdempotencyKey,
  requireOfCapability("plan_draft"),
  createPlanningDraft
);
router.post(
  "/:ofId/planning-versions/:versionId/submit",
  requireOfCapability("plan_draft"),
  submitPlanning
);

// Valider et refuser engagent la charge et le client : capacité étroite.
router.post(
  "/:ofId/planning-versions/:versionId/validate",
  requireOfCapability("plan_validate"),
  validatePlanning
);
router.post(
  "/:ofId/planning-versions/:versionId/refuse",
  requireOfCapability("plan_validate"),
  refusePlanning
);

/* -------------------------- AR client, par OF ----------------------------- */

router.post(
  "/:ofId/ar-dossiers",
  requireIdempotencyKey,
  requireOfCapability("ar_recalage"),
  createArDossier
);

/* -------------------------------- Document -------------------------------- */

// Aperçu : même read-model que le PDF, aucun effet de bord.
router.get("/:ofId/document/preview", requireOfCapability("document"), previewPayload);
router.get("/:ofId/document/preview.pdf", requireOfCapability("document"), previewPdf);

router.get("/:ofId/documents", requireOfCapability("read"), listDocuments);

// Émission : fige le payload, hache le binaire, archive en GED.
router.post(
  "/:ofId/documents",
  requireIdempotencyKey,
  requireOfCapability("document"),
  emitDocument
);

// Réimpression : restitue le binaire archivé, ne crée aucune révision.
router.get("/:ofId/documents/:documentId/pdf", requireOfCapability("document"), reprintDocument);

export default router;
