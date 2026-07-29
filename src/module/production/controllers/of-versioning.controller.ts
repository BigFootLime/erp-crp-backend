// Contrôleurs HTTP du chantier #370.
//
// Volontairement minces : ils valident la forme, construisent l'acteur et le
// contexte d'audit, appellent le service, et rendent la réponse. Aucune règle
// métier ici — elle serait alors dupliquée entre l'HTTP et le domaine, et les
// deux finiraient par diverger.

import type { Request, Response } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { buildAuditContext } from "../../project-office/controllers/project-office.controller";
import { readMachineFamilies } from "../repository/of-versioning.repository";
import { roleHasOfCapability, type OfCapability } from "../domain/of-rbac";
import * as service from "../services/of-versioning.service";
import { idempotencyKeyOf } from "../middlewares/of-versioning-authorization.middleware";
import {
  assessVarianceSchema,
  compareRevisionsQuery,
  createArDossierSchema,
  createPlanningDraftSchema,
  createProposalSchema,
  createRevisionSchema,
  createVisaSchema,
  documentIdParam,
  emitDocumentSchema,
  listArQuery,
  ofIdParam,
  planningDecisionSchema,
  planningIdParam,
  previewDocumentQuery,
  resolveProposalSchema,
  revisionIdParam,
  updateArDossierSchema,
} from "../validators/of-versioning.validators";

function actorOf(req: Request): service.OfActor {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  return {
    userId: user.id,
    username: typeof user.username === "string" ? user.username : `#${user.id}`,
    role: typeof user.role === "string" ? user.role : null,
  };
}

/**
 * Horodatage d'émission, lu UNE fois par requête.
 *
 * Il entre dans le payload figé et dans les métadonnées du PDF. Le lire une seule
 * fois est ce qui rend le rendu reproductible : deux lectures d'horloge dans la
 * même émission produiraient deux binaires différents.
 */
function requestNowIso(): string {
  return new Date().toISOString();
}

/* ------------------------------- Capacités -------------------------------- */

// L'UI s'en sert pour n'AFFICHER que ce qui est permis. Le backend revérifie
// systématiquement : cette route ne remplace aucune garde.
export const capabilities = asyncHandler(async (req: Request, res: Response) => {
  const role = typeof req.user?.role === "string" ? req.user.role : null;
  const keys: OfCapability[] = [
    "read",
    "revise",
    "visa",
    "plan_draft",
    "plan_validate",
    "ar_recalage",
    "document",
  ];
  const result: Record<string, boolean> = {};
  for (const key of keys) result[key] = roleHasOfCapability(role, key);
  res.json({ capabilities: result });
});

export const listMachineFamilies = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ familles: await readMachineFamilies() });
});

/* ------------------------------- Révisions -------------------------------- */

export const listRevisions = asyncHandler(async (req: Request, res: Response) => {
  const { ofId } = ofIdParam.parse(req.params);
  res.json(await service.listRevisions(ofId));
});

export const getRevision = asyncHandler(async (req: Request, res: Response) => {
  const { ofId, revisionId } = revisionIdParam.parse(req.params);
  res.json(await service.getRevisionDetail(ofId, revisionId));
});

export const createRevision = asyncHandler(async (req: Request, res: Response) => {
  const { ofId } = ofIdParam.parse(req.params);
  const body = createRevisionSchema.parse(req.body);
  const familles = await readMachineFamilies();
  const result = await service.createRevision(
    ofId,
    { motif: body.motif ?? null, operations: body.operations },
    actorOf(req),
    buildAuditContext(req),
    familles
  );
  res.status(201).json(result);
});

export const compareRevisions = asyncHandler(async (req: Request, res: Response) => {
  const { ofId } = ofIdParam.parse(req.params);
  const { from, to } = compareRevisionsQuery.parse(req.query);
  res.json(await service.compareRevisions(ofId, from, to));
});

/* --------------------------------- VISA ----------------------------------- */

export const createVisa = asyncHandler(async (req: Request, res: Response) => {
  const { ofId, revisionId } = revisionIdParam.parse(req.params);
  const body = createVisaSchema.parse(req.body);
  const result = await service.createVisa(
    ofId,
    revisionId,
    {
      phase: body.phase,
      statut: body.statut,
      initials: body.initials,
      quantiteBonne: body.quantiteBonne ?? null,
      quantiteRebut: body.quantiteRebut ?? null,
      motifRebut: body.motifRebut ?? null,
      controleInitials: body.controleInitials ?? null,
      comment: body.comment ?? null,
    },
    actorOf(req),
    buildAuditContext(req)
  );
  res.status(201).json(result);
});

/* --------------------------- Dérive de temps ------------------------------ */

// Évaluation en LECTURE SEULE : aucune écriture, donc aucune clé d'idempotence.
export const assessVariance = asyncHandler(async (req: Request, res: Response) => {
  const { ofId } = ofIdParam.parse(req.params);
  const body = assessVarianceSchema.parse(req.body);
  res.json(await service.assessVariance(ofId, body));
});

export const createProposal = asyncHandler(async (req: Request, res: Response) => {
  const { ofId } = ofIdParam.parse(req.params);
  const body = createProposalSchema.parse(req.body);
  const result = await service.createProposal(
    ofId,
    { phase: body.phase, newTime: body.newTime, cause: body.cause, causeComment: body.causeComment ?? null },
    actorOf(req),
    buildAuditContext(req),
    idempotencyKeyOf(req)
  );
  // 200 et non 201 quand la dérive est dans la tolérance : rien n'a été créé, et
  // répondre 201 laisserait croire à une proposition inexistante.
  res.status(result.proposal ? 201 : 200).json(result);
});

export const listProposals = asyncHandler(async (req: Request, res: Response) => {
  const { ofId } = ofIdParam.parse(req.params);
  res.json({ proposals: await service.listProposals(ofId) });
});

export const resolveProposal = asyncHandler(async (req: Request, res: Response) => {
  const { ofId } = ofIdParam.parse(req.params);
  const proposalId = String(req.params.proposalId ?? "");
  const body = resolveProposalSchema.parse(req.body);
  res.json(
    await service.resolveProposal(
      ofId,
      proposalId,
      { statut: body.statut, comment: body.comment ?? null },
      actorOf(req),
      buildAuditContext(req)
    )
  );
});

/* ----------------------------- Planning ----------------------------------- */

export const listPlanningVersions = asyncHandler(async (req: Request, res: Response) => {
  const { ofId } = ofIdParam.parse(req.params);
  res.json(await service.listPlanningVersions(ofId));
});

export const createPlanningDraft = asyncHandler(async (req: Request, res: Response) => {
  const { ofId } = ofIdParam.parse(req.params);
  const body = createPlanningDraftSchema.parse(req.body);
  const result = await service.createPlanningDraft(
    ofId,
    {
      payload: body.payload as never,
      sourceProposalId: body.sourceProposalId ?? null,
    },
    actorOf(req),
    buildAuditContext(req),
    idempotencyKeyOf(req)
  );
  res.status(201).json(result);
});

function planningTransition(next: "SOUMIS" | "VALIDE" | "REFUSE") {
  return asyncHandler(async (req: Request, res: Response) => {
    const { ofId, versionId } = planningIdParam.parse(req.params);
    const body = planningDecisionSchema.parse(req.body ?? {});
    res.json(
      await service.transitionPlanning(
        ofId,
        versionId,
        next,
        { comment: body.comment ?? null },
        actorOf(req),
        buildAuditContext(req)
      )
    );
  });
}

export const submitPlanning = planningTransition("SOUMIS");
export const validatePlanning = planningTransition("VALIDE");
export const refusePlanning = planningTransition("REFUSE");

/* ------------------------------- AR client -------------------------------- */

export const listArDossiers = asyncHandler(async (req: Request, res: Response) => {
  const query = listArQuery.parse(req.query);
  res.json({ dossiers: await service.listArDossiers(query) });
});

export const createArDossier = asyncHandler(async (req: Request, res: Response) => {
  const { ofId } = ofIdParam.parse(req.params);
  const body = createArDossierSchema.parse(req.body);
  const result = await service.createArDossier(
    ofId,
    {
      affaireId: body.affaireId ?? null,
      previousDate: body.previousDate ?? null,
      newDate: body.newDate ?? null,
      previousCadence: body.previousCadence ?? null,
      newCadence: body.newCadence ?? null,
      quantite: body.quantite ?? null,
      motif: body.motif,
      commentaire: body.commentaire ?? null,
      ownerUserId: body.ownerUserId ?? null,
    },
    actorOf(req),
    buildAuditContext(req),
    idempotencyKeyOf(req)
  );
  res.status(201).json(result);
});

export const updateArDossier = asyncHandler(async (req: Request, res: Response) => {
  const dossierId = String(req.params.dossierId ?? "");
  const body = updateArDossierSchema.parse(req.body);
  res.json(
    await service.updateArDossier(
      dossierId,
      {
        statut: body.statut,
        ownerUserId: body.ownerUserId ?? null,
        commentaire: body.commentaire ?? null,
      },
      actorOf(req),
      buildAuditContext(req)
    )
  );
});

/* -------------------------------- Document -------------------------------- */

/**
 * Payload d'aperçu, en JSON.
 *
 * C'est le MÊME read-model que celui du PDF. L'écran affiche les libellés déjà
 * calculés ici : il ne reformate rien, donc il ne peut pas divergier.
 */
export const previewPayload = asyncHandler(async (req: Request, res: Response) => {
  const { ofId } = ofIdParam.parse(req.params);
  const { revisionId } = previewDocumentQuery.parse(req.query);
  const { payload } = await service.buildDocumentPayload(ofId, {
    revisionId: revisionId ?? null,
    documentStatut: "BROUILLON",
    generatedAt: requestNowIso(),
    auteur: actorOf(req).username,
  });
  res.json({ payload });
});

/** Aperçu PDF : rendu serveur, aucun effet de bord, jamais `window.print()`. */
export const previewPdf = asyncHandler(async (req: Request, res: Response) => {
  const { ofId } = ofIdParam.parse(req.params);
  const { revisionId } = previewDocumentQuery.parse(req.query);
  const result = await service.previewDocument(
    ofId,
    revisionId ?? null,
    actorOf(req),
    requestNowIso()
  );
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", String(result.byteSize));
  res.setHeader("X-Document-Sha256", result.sha256);
  res.setHeader("X-Snapshot-Sha256", result.payload.snapshotSha256);
  res.setHeader(
    "Content-Disposition",
    `inline; filename="apercu-OF-${result.payload.ofNumero}-${result.payload.revisionCode}.pdf"`
  );
  res.end(result.buffer);
});

export const listDocuments = asyncHandler(async (req: Request, res: Response) => {
  const { ofId } = ofIdParam.parse(req.params);
  res.json({ documents: await service.listDocuments(ofId) });
});

export const emitDocument = asyncHandler(async (req: Request, res: Response) => {
  const { ofId } = ofIdParam.parse(req.params);
  const body = emitDocumentSchema.parse(req.body ?? {});
  const result = await service.emitDocument(
    ofId,
    {
      revisionId: body.revisionId ?? null,
      expectedSnapshotSha256: body.expectedSnapshotSha256 ?? null,
    },
    actorOf(req),
    buildAuditContext(req),
    idempotencyKeyOf(req),
    requestNowIso()
  );
  res.status(result.replayed ? 200 : 201).json({
    document: result.document,
    replayed: result.replayed,
    archive: "archive" in result ? result.archive : null,
  });
});

/** Réimpression : restitue le binaire archivé. Ne crée aucune révision. */
export const reprintDocument = asyncHandler(async (req: Request, res: Response) => {
  const { ofId, documentId } = documentIdParam.parse(req.params);
  const result = await service.reprintDocument(ofId, documentId, buildAuditContext(req));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", String(result.pdf.byteLength));
  res.setHeader("X-Document-Sha256", String(result.document.pdf_sha256));
  res.setHeader("X-Reprint-Source", result.source);
  res.setHeader("Content-Disposition", `inline; filename="OF-${documentId}.pdf"`);
  res.end(result.pdf);
});
