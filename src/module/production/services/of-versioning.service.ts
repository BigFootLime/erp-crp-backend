// Orchestration du chantier « OF, versioning, replanification, AR, document » (#370).
//
// Le domaine décide, ce service exécute. Aucune règle métier n'est réécrite ici :
// les seuils, les diffs, les transitions et les décisions d'AR viennent des modules
// purs de `../domain`, qui sont testables sans base.
//
// Trois invariants tenus par ce fichier :
//   1. Une écriture et son audit vivent dans la MÊME transaction.
//   2. Le planning ACTIF n'est jamais muté par une création de brouillon.
//   3. Une réimpression ne crée ni révision, ni document, ni version GED.

import { HttpError } from "../../../utils/httpError";
import {
  buildInternalNotification,
  notificationDedupeKey,
  NOTIFICATION_TOPICS,
  resolveNotificationRecipients,
} from "../../../shared/notifications/routing";
import {
  insertAuditLog,
  type AuditContext,
} from "../../project-office/repository/project-office.repository";
import {
  buildRevisionSnapshot,
  checkRevisionCreation,
  diffRevisionSnapshots,
  formatRevisionCode,
  hashSnapshot,
  nextRevisionRank,
  type MachineFamilyRef,
  type OfRevisionOperation,
  type OfRevisionSnapshotInput,
} from "../domain/of-revision";
import {
  assessTimeVariance,
  buildTimeVarianceProposal,
  describeProposal,
  isOfTimeVarianceCause,
  type OfTimeVarianceCause,
} from "../domain/of-time-variance";
import {
  buildPlanningPayload,
  checkPlanningTransition,
  comparePlanningVersions,
  hashPlanningPayload,
  requiresArRecalage,
  type OfPlanningPayload,
  type OfPlanningStatut,
} from "../domain/of-planning-version";
import {
  buildArRecalageDossiers,
  canTransitionArStatut,
  decideArRecalage,
  validateArRecalageInput,
  type ArRecalageStatut,
} from "../domain/ar-recalage";
import {
  buildOfDocumentPayload,
  hashDocumentPayload,
  watermarkFor,
  type OfDocumentPayload,
} from "../domain/of-document";
import { renderOfDocument } from "./of-document-render";
import {
  archiveOfDocument,
  compensateOfDocumentArchive,
  publicOfDocumentArchiveResult,
  readArchivedOfDocument,
  type OfDocumentArchiveResult,
  type PublicOfDocumentArchiveResult,
} from "./of-document-archive";
import {
  reconcileOfDocumentCommit,
  type OfDocumentCommitContext,
} from "./of-document-commit";
import { storageKeyForSha256 } from "../../ged/services/ged-vault.service";
import * as repo from "../repository/of-versioning.repository";

export type OfActor = {
  userId: number;
  username: string;
  role: string | null | undefined;
};

/* ========================================================================== */
/* A) Révisions                                                               */
/* ========================================================================== */

export async function listRevisions(ofId: number) {
  const header = await repo.readOfHeader(ofId);
  const revisions = await repo.listRevisions(ofId);
  return { of: header, revisions };
}

export async function getRevisionDetail(ofId: number, revisionId: string) {
  await repo.readOfHeader(ofId);
  const revision = await repo.getRevision(ofId, revisionId);
  if (!revision) {
    // 404 et non 403 : confirmer l'existence d'une révision appartenant à un
    // autre OF renseignerait l'appelant sur un dossier qui ne le concerne pas.
    throw new HttpError(404, "OF_REVISION_NOT_FOUND", "Révision introuvable sur cet ordre de fabrication.");
  }
  const [operations, visas] = await Promise.all([
    repo.listOperations(ofId, revisionId),
    repo.listVisas(ofId, revisionId),
  ]);
  return { revision, operations, visas };
}

/** Instantané de l'état courant, prêt à être figé dans une révision. */
async function buildCurrentSnapshot(
  ofId: number,
  revisionId: string | null,
  tx?: repo.DbQueryer
): Promise<{ snapshot: OfRevisionSnapshotInput; operations: OfRevisionOperation[] }> {
  const header = await repo.readOfHeader(ofId, tx);
  const operations = revisionId ? await repo.listOperations(ofId, revisionId, tx) : [];

  return {
    operations,
    snapshot: {
      ofId: header.of_id,
      ofNumero: header.numero,
      pieceReference: header.piece_reference,
      pieceDesignation: header.piece_designation,
      pieceIndice: header.piece_indice,
      gammeId: header.gamme_id,
      gammeCode: header.gamme_code,
      gammeVersion: header.gamme_version,
      quantiteLancee: header.quantite_lancee,
      matiere: null,
      operations,
    },
  };
}

export type CreateRevisionInput = {
  motif: string | null;
  /** Modifications de phases à appliquer sur la NOUVELLE révision. */
  operations?: Array<{
    phase: number;
    designation?: string;
    family?: string | null;
    machineId?: string | null;
    programme?: string | null;
    tempsUnitaire?: number;
    preparation?: number;
    quantiteBase?: number;
    coefficient?: number;
  }>;
};

/**
 * Crée une révision.
 *
 * L'ancienne révision n'est PAS modifiée : ses opérations restent en place, avec
 * leurs pointages et leurs VISA. Les opérations sont RECOPIÉES vers la nouvelle
 * révision, puis les modifications s'y appliquent. C'est l'unicité
 * `(of_id, revision_id, phase)` qui rend cette coexistence possible.
 */
export async function createRevision(
  ofId: number,
  input: CreateRevisionInput,
  actor: OfActor,
  audit: AuditContext,
  familles: MachineFamilyRef[]
) {
  return repo.withOfTransaction(async (tx) => {
    await repo.lockOf(tx, ofId);

    const header = await repo.readOfHeader(ofId, tx);
    const current = await repo.getActiveRevision(ofId, tx);
    const rank = nextRevisionRank(current ? current.revision_rank : null);
    const code = formatRevisionCode(rank);

    const before = current
      ? ((current.snapshot as OfRevisionSnapshotInput | null) ?? null)
      : null;

    // 1) La révision est créée d'abord : les opérations recopiées ont besoin de
    //    son identifiant pour exister sans écraser celles de la précédente.
    const provisional = buildRevisionSnapshot({
      ...(await buildCurrentSnapshot(ofId, current?.id ?? null, tx)).snapshot,
    });

    const created = await repo.insertRevision(tx, {
      ofId,
      rank,
      code,
      snapshot: provisional,
      snapshotSha256: hashSnapshot(provisional),
      diff: null,
      motif: input.motif,
      authorUserId: actor.userId,
    });

    if (current) {
      await repo.copyOperationsToRevision(tx, {
        ofId,
        fromRevisionId: current.id,
        toRevisionId: created.id,
      });
    }

    // 2) Les modifications s'appliquent à la nouvelle révision uniquement.
    for (const change of input.operations ?? []) {
      if (change.family !== undefined && change.family !== null) {
        // Une famille absente du référentiel est refusée : elle produirait une
        // gamme qui ne correspond à aucun atelier.
        if (!familles.some((f) => f.code === change.family)) {
          throw new HttpError(
            422,
            "OF_FAMILY_UNKNOWN",
            `Famille machine inconnue du référentiel : ${change.family}.`
          );
        }
      }
      await repo.updateOperationOnRevision(tx, { ofId, revisionId: created.id, ...change });
    }

    // 3) L'instantané définitif est reconstruit APRÈS modification, puis haché.
    const after = buildRevisionSnapshot(
      (await buildCurrentSnapshot(ofId, created.id, tx)).snapshot
    );
    const diff = diffRevisionSnapshots(before, after);

    // 4) La règle métier tranche : motif obligatoire dès R01, refus si identique.
    const check = checkRevisionCreation({ nextRank: rank, motif: input.motif, diff });
    if (!check.allowed) {
      // Le rollback annule la révision ET la recopie des opérations : rien ne
      // subsiste d'une révision refusée.
      throw new HttpError(422, check.code, check.message);
    }

    const sha256 = hashSnapshot(after);
    await tx.query(
      `UPDATE public.of_revisions SET snapshot = $2::jsonb, snapshot_sha256 = $3, diff = $4::jsonb
        WHERE id = $1::uuid`,
      [created.id, JSON.stringify(after), sha256, JSON.stringify(diff)]
    );

    await insertAuditLog(tx, audit, {
      action: "OF_REVISION_CREATE",
      entity_type: "of_revision",
      entity_id: created.id,
      details: {
        of_id: ofId,
        of_numero: header.numero,
        revision_code: code,
        motif: input.motif,
        snapshot_sha256: sha256,
        phases_ajoutees: diff.summary.phasesAjoutees,
        phases_retirees: diff.summary.phasesRetirees,
        phases_modifiees: diff.summary.phasesModifiees,
        delta_temps_total_h: diff.summary.deltaTempsTotalH,
      },
    });

    const refreshed = await repo.getRevision(ofId, created.id, tx);
    return { revision: refreshed, diff };
  });
}

export async function compareRevisions(ofId: number, fromId: string, toId: string) {
  await repo.readOfHeader(ofId);
  const [from, to] = await Promise.all([
    repo.getRevision(ofId, fromId),
    repo.getRevision(ofId, toId),
  ]);
  if (!from || !to) {
    throw new HttpError(404, "OF_REVISION_NOT_FOUND", "Révision introuvable sur cet ordre de fabrication.");
  }
  const diff = diffRevisionSnapshots(
    from.snapshot as OfRevisionSnapshotInput,
    to.snapshot as OfRevisionSnapshotInput
  );
  return { from, to, diff };
}

/* ========================================================================== */
/* B) VISA de phase                                                           */
/* ========================================================================== */

export type CreateVisaInput = {
  phase: number;
  statut: string;
  initials: string;
  quantiteBonne: number | null;
  quantiteRebut: number | null;
  motifRebut: string | null;
  controleInitials: string | null;
  comment: string | null;
};

export async function createVisa(
  ofId: number,
  revisionId: string,
  input: CreateVisaInput,
  actor: OfActor,
  audit: AuditContext
) {
  return repo.withOfTransaction(async (tx) => {
    const revision = await repo.getRevision(ofId, revisionId, tx);
    if (!revision) {
      throw new HttpError(404, "OF_REVISION_NOT_FOUND", "Révision introuvable sur cet ordre de fabrication.");
    }
    // Viser une révision obsolète réécrirait l'histoire : le VISA appartient à la
    // révision sous laquelle la phase a été faite.
    if (revision.statut === "OBSOLETE") {
      throw new HttpError(
        409,
        "OF_REVISION_OBSOLETE",
        "Cette révision est obsolète : elle ne peut plus être visée."
      );
    }

    const visaId = await repo.insertVisa(tx, {
      ofId,
      revisionId,
      phase: input.phase,
      userId: actor.userId,
      initials: input.initials,
      statut: input.statut,
      quantiteBonne: input.quantiteBonne,
      quantiteRebut: input.quantiteRebut,
      motifRebut: input.motifRebut,
      controleUserId: input.controleInitials ? actor.userId : null,
      controleInitials: input.controleInitials,
      comment: input.comment,
    });

    await insertAuditLog(tx, audit, {
      action: "OF_VISA_CREATE",
      entity_type: "of_operation_visa",
      entity_id: visaId,
      details: {
        of_id: ofId,
        revision_id: revisionId,
        revision_code: revision.revision_code,
        phase: input.phase,
        statut: input.statut,
        quantite_bonne: input.quantiteBonne,
        quantite_rebut: input.quantiteRebut,
      },
    });

    return { visaId };
  });
}

/* ========================================================================== */
/* C) Dérive de temps et proposition de replanification                       */
/* ========================================================================== */

/**
 * Évalue une dérive sans rien écrire.
 *
 * SOURCE DU TEMPS DE RÉFÉRENCE — documentée et unique : c'est le temps de
 * fabrication figé dans la révision ACTIVE de l'OF pour cette phase, soit
 * `of_operations.temps_fabrication_planned` de la révision active
 * (= `tf_unit x qte x coef` au moment du lancement). Ce n'est PAS le temps de la
 * gamme de la pièce technique : celle-ci peut avoir bougé depuis le lancement, et
 * comparer un temps reprogrammé à une gamme modifiée entre-temps mesurerait deux
 * changements à la fois. Ce n'est pas non plus un temps réel pointé : la dérive
 * mesurée ici est une dérive de PRÉVISION, décidée à la programmation.
 *
 * Référence absente ou nulle : revue humaine, sans division.
 */
export async function assessVariance(
  ofId: number,
  input: { phase: number; newTime: number }
) {
  await repo.readOfHeader(ofId);
  const active = await repo.getActiveRevision(ofId);
  if (!active) {
    throw new HttpError(409, "OF_NO_ACTIVE_REVISION", "Cet OF n'a aucune révision active.");
  }
  const operations = await repo.listOperations(ofId, active.id);
  const operation = operations.find((op) => op.phase === input.phase);
  if (!operation) {
    throw new HttpError(404, "OF_PHASE_NOT_FOUND", `Phase ${input.phase} absente de la révision active.`);
  }

  const referenceTime = operation.tempsUnitaire * operation.quantiteBase * operation.coefficient;
  const assessment = assessTimeVariance({
    // Un temps de référence nul est transmis tel quel : le domaine le traite en
    // revue humaine. Le remplacer par une valeur par défaut fabriquerait une
    // dérive qui n'a pas de sens.
    referenceTime: referenceTime === 0 ? null : referenceTime,
    newTime: input.newTime,
  });

  return {
    revision: { id: active.id, code: active.revision_code },
    phase: input.phase,
    referenceTime: referenceTime === 0 ? null : referenceTime,
    referenceSource:
      "temps_fabrication_planned de la révision active (tf_unit x qte x coef figés au lancement)",
    newTime: input.newTime,
    assessment,
  };
}

export type CreateProposalInput = {
  phase: number;
  newTime: number;
  cause: OfTimeVarianceCause;
  causeComment: string | null;
};

export async function createProposal(
  ofId: number,
  input: CreateProposalInput,
  actor: OfActor,
  audit: AuditContext,
  idempotencyKey: string | null
) {
  if (!isOfTimeVarianceCause(input.cause)) {
    throw new HttpError(422, "OF_VARIANCE_CAUSE_INVALID", `Cause de dérive inconnue : ${input.cause}.`);
  }

  return repo.withOfTransaction(async (tx) => {
    if (idempotencyKey) {
      const existing = await repo.findProposalByIdempotencyKey(tx, idempotencyKey);
      // Rejouer la même clé ne recrée rien et ne renvoie pas d'erreur : c'est le
      // contrat d'idempotence, un retry réseau doit être indolore.
      if (existing) return { proposal: existing, replayed: true, notified: [] as number[] };
    }

    const header = await repo.readOfHeader(ofId, tx);
    const active = await repo.getActiveRevision(ofId, tx);
    if (!active) {
      throw new HttpError(409, "OF_NO_ACTIVE_REVISION", "Cet OF n'a aucune révision active.");
    }

    const operations = await repo.listOperations(ofId, active.id, tx);
    const operation = operations.find((op) => op.phase === input.phase);
    if (!operation) {
      throw new HttpError(404, "OF_PHASE_NOT_FOUND", `Phase ${input.phase} absente de la révision active.`);
    }

    const referenceRaw = operation.tempsUnitaire * operation.quantiteBase * operation.coefficient;
    const referenceTime = referenceRaw === 0 ? null : referenceRaw;

    const chargeAvantH = operations.reduce(
      (sum, op) => sum + op.preparation + op.tempsUnitaire * op.quantiteBase * op.coefficient,
      0
    );
    const chargeApresH = chargeAvantH - referenceRaw + input.newTime;

    const built = buildTimeVarianceProposal({
      ofId,
      ofNumero: header.numero,
      revisionId: active.id,
      revisionCode: active.revision_code,
      ofOperationId: operation.id,
      phase: input.phase,
      family: operation.family,
      referenceTime,
      newTime: input.newTime,
      cause: input.cause,
      causeComment: input.causeComment,
      authorUserId: actor.userId,
      impactCharge: {
        chargeAvantH: round4(chargeAvantH),
        chargeApresH: round4(chargeApresH),
        deltaH: round4(chargeApresH - chargeAvantH),
        operationsImpactees: 1,
      },
      machines: [
        {
          machineId: operation.machineId,
          machineLabel: operation.machineLabel,
          family: operation.family,
          deltaHeures: round4(input.newTime - referenceRaw),
        },
      ],
      affaires: header.affaire_id
        ? [
            {
              affaireId: header.affaire_id,
              affaireNumero: null,
              clientId: header.client_id,
              clientNom: header.client_nom,
              delaiClient: header.date_fin_prevue,
            },
          ]
        : [],
      simulation: {
        schema: "of-time-variance-simulation/1",
        decalageFinJours: null,
        dateFinAvant: header.date_fin_prevue,
        dateFinApres: null,
        engagementsEnRisque: [],
      },
    });

    // Dérive dans la tolérance : rien n'est écrit. Consigner une non-dérive
    // noierait les vraies alertes du planificateur.
    if (!built.created) {
      return { proposal: null, assessment: built.assessment, replayed: false, notified: [] as number[] };
    }

    const proposalId = await repo.insertProposal(tx, {
      ofId,
      revisionId: active.id,
      ofOperationId: operation.id,
      phase: input.phase,
      referenceTime,
      newTime: input.newTime,
      variationPct: built.proposal.variationPct,
      outcome: built.proposal.outcome,
      reviewRequired: built.proposal.reviewRequired,
      cause: built.proposal.cause,
      causeComment: built.proposal.causeComment,
      impactCharge: built.proposal.impactCharge,
      machines: built.proposal.machines,
      affaires: built.proposal.affaires,
      simulation: built.proposal.simulation,
      authorUserId: actor.userId,
      idempotencyKey,
    });

    const notified = await notifyTopic(
      tx,
      NOTIFICATION_TOPICS.OF_TIME_VARIANCE,
      describeProposal(built.proposal)
    );

    await insertAuditLog(tx, audit, {
      action: "OF_TIME_VARIANCE_PROPOSE",
      entity_type: "of_time_variance_proposal",
      entity_id: proposalId,
      details: {
        of_id: ofId,
        of_numero: header.numero,
        phase: input.phase,
        reference_time: referenceTime,
        new_time: input.newTime,
        variation_pct: built.proposal.variationPct,
        outcome: built.proposal.outcome,
        cause: built.proposal.cause,
        notified_user_ids: notified,
      },
    });

    const stored = await repo.findProposalByIdempotencyKey(tx, idempotencyKey ?? "");
    return {
      proposal: stored ?? { id: proposalId },
      assessment: built.assessment,
      replayed: false,
      notified,
    };
  });
}

export async function listProposals(ofId: number) {
  await repo.readOfHeader(ofId);
  return repo.listProposals(ofId);
}

export async function resolveProposal(
  ofId: number,
  proposalId: string,
  input: { statut: "ACCEPTEE" | "REFUSEE" | "CADUQUE"; comment: string | null },
  actor: OfActor,
  audit: AuditContext
) {
  return repo.withOfTransaction(async (tx) => {
    await repo.readOfHeader(ofId, tx);
    await repo.resolveProposal(tx, {
      ofId,
      proposalId,
      statut: input.statut,
      userId: actor.userId,
      comment: input.comment,
    });
    await insertAuditLog(tx, audit, {
      action: "OF_TIME_VARIANCE_RESOLVE",
      entity_type: "of_time_variance_proposal",
      entity_id: proposalId,
      details: { of_id: ofId, statut: input.statut, comment: input.comment },
    });
    return { ok: true };
  });
}

/* ========================================================================== */
/* D) Versions de planning                                                    */
/* ========================================================================== */

export async function listPlanningVersions(ofId: number) {
  await repo.readOfHeader(ofId);
  const versions = await repo.listPlanningVersions(ofId);
  return { versions };
}

/**
 * Crée un brouillon de planning.
 *
 * Le plan ACTIF n'est ni lu en écriture ni touché : il sert de BASE de comparaison
 * et rien de plus. Son identifiant est enregistré comme `base_version_id`, ce qui
 * donne le verrou optimiste à la validation — si l'ACTIF a changé entre-temps, la
 * validation refuse au lieu d'appliquer un brouillon calculé sur un autre état.
 */
export async function createPlanningDraft(
  ofId: number,
  input: { payload: OfPlanningPayload; sourceProposalId: string | null },
  actor: OfActor,
  audit: AuditContext,
  idempotencyKey: string | null
) {
  return repo.withOfTransaction(async (tx) => {
    if (idempotencyKey) {
      const existing = await repo.findPlanningByIdempotencyKey(tx, idempotencyKey);
      if (existing) return { version: existing, replayed: true, comparison: existing.comparison };
    }

    await repo.lockOf(tx, ofId);
    const header = await repo.readOfHeader(ofId, tx);

    const openDraft = await repo.getPlanningByStatut(ofId, ["BROUILLON", "SOUMIS"], tx);
    if (openDraft) {
      throw new HttpError(
        409,
        "OF_PLANNING_DRAFT_EXISTS",
        `Un brouillon de planning est déjà en circuit (${openDraft.statut}) sur cet OF.`
      );
    }

    const active = await repo.getPlanningByStatut(ofId, ["ACTIF"], tx);
    const activeRevision = await repo.getActiveRevision(ofId, tx);

    const payload = buildPlanningPayload(input.payload);
    const comparison = active
      ? comparePlanningVersions(active.payload, payload)
      : comparePlanningVersions(null, payload);

    const rank = await repo.nextPlanningRank(tx, ofId);
    const version = await repo.insertPlanningVersion(tx, {
      ofId,
      revisionId: activeRevision?.id ?? null,
      rank,
      statut: "BROUILLON",
      payload,
      payloadSha256: hashPlanningPayload(payload),
      baseVersionId: active?.id ?? null,
      comparison,
      clientImpact: comparison.clientImpact,
      sourceProposalId: input.sourceProposalId,
      authorUserId: actor.userId,
      idempotencyKey,
    });

    await insertAuditLog(tx, audit, {
      action: "OF_PLANNING_DRAFT_CREATE",
      entity_type: "of_planning_version",
      entity_id: version.id,
      details: {
        of_id: ofId,
        of_numero: header.numero,
        version_rank: rank,
        base_version_id: active?.id ?? null,
        client_impact: comparison.clientImpact,
        payload_sha256: version.payload_sha256,
      },
    });

    return { version, comparison, replayed: false };
  });
}

export async function transitionPlanning(
  ofId: number,
  versionId: string,
  next: OfPlanningStatut,
  input: { comment: string | null },
  actor: OfActor,
  audit: AuditContext
) {
  return repo.withOfTransaction(async (tx) => {
    await repo.lockOf(tx, ofId);
    const header = await repo.readOfHeader(ofId, tx);

    const version = await repo.getPlanningVersion(ofId, versionId, tx);
    if (!version) {
      throw new HttpError(404, "OF_PLANNING_NOT_FOUND", "Version de planning introuvable sur cet OF.");
    }

    const check = checkPlanningTransition(version.statut, next);
    if (!check.allowed) throw new HttpError(422, check.code, check.message);

    // Un refus sans motif n'est pas un refus exploitable : celui qui a soumis le
    // brouillon doit savoir ce qu'il doit corriger.
    if (next === "REFUSE" && !(input.comment ?? "").trim()) {
      throw new HttpError(
        422,
        "OF_PLANNING_REFUSAL_COMMENT_REQUIRED",
        "Un refus de planning exige un motif."
      );
    }

    await repo.transitionPlanningVersion(tx, {
      ofId,
      versionId,
      expectedStatut: version.statut,
      nextStatut: next,
      userId: actor.userId,
      comment: input.comment,
    });

    const dossiers: string[] = [];
    let notified: number[] = [];

    if (next === "SOUMIS") {
      notified = await notifyTopic(
        tx,
        NOTIFICATION_TOPICS.OF_PLANNING_SUBMITTED,
        `${header.numero} — planning v${version.version_rank} soumis à validation.`
      );
    }

    // C'est la VALIDATION qui applique. Tant qu'elle n'a pas eu lieu, le plan
    // ACTIF est intact — c'est l'invariant central de ce cycle.
    if (next === "VALIDE") {
      const active = await repo.getPlanningByStatut(ofId, ["ACTIF"], tx);

      // Verrou optimiste : le brouillon a été calculé contre un ACTIF précis.
      if ((active?.id ?? null) !== version.base_version_id) {
        throw new HttpError(
          409,
          "OF_PLANNING_BASE_CHANGED",
          "Le planning actif a changé depuis la création de ce brouillon : reprendre la comparaison avant de valider."
        );
      }

      if (active) {
        await repo.transitionPlanningVersion(tx, {
          ofId,
          versionId: active.id,
          expectedStatut: "ACTIF",
          nextStatut: "SUPERSEDE",
          userId: actor.userId,
        });
      }

      await repo.transitionPlanningVersion(tx, {
        ofId,
        versionId,
        expectedStatut: "VALIDE",
        nextStatut: "ACTIF",
        userId: actor.userId,
      });

      // Un dossier d'AR n'est ouvert QUE si une date ou une cadence client est
      // réellement touchée. Un décalage purement interne n'en crée aucun.
      const comparison = version.comparison as ReturnType<typeof comparePlanningVersions> | null;
      if (comparison && requiresArRecalage(comparison)) {
        const decision = decideArRecalage(comparison);
        if (decision.required) {
          const built = buildArRecalageDossiers({
            ofId,
            ofNumero: header.numero,
            planningVersionId: versionId,
            comparison,
            // Motif par défaut d'un recalage issu d'une validation de planning.
            // Le service de l'AR peut le préciser ensuite ; il n'est jamais vide.
            motif: "MODIFICATION_TECHNIQUE",
            commentaire: input.comment,
            ownerUserId: null,
            clientNomByClientId: header.client_id
              ? { [header.client_id]: header.client_nom }
              : undefined,
            commandeNumeroById: header.commande_id
              ? { [header.commande_id]: header.commande_numero }
              : undefined,
          });
          for (const dossier of built) {
            const id = await repo.insertArDossier(tx, {
              clientId: dossier.clientId,
              commandeId: dossier.commandeId,
              affaireId: dossier.affaireId,
              ofId,
              planningVersionId: versionId,
              previousDate: dossier.previousDate,
              newDate: dossier.newDate,
              previousCadence: dossier.previousCadence,
              newCadence: dossier.newCadence,
              quantite: dossier.quantite,
              motif: dossier.motif,
              commentaire: dossier.commentaire,
              ownerUserId: null,
              createdBy: actor.userId,
              idempotencyKey: `ar:${versionId}:${dossier.affaireId ?? "na"}`,
            });
            dossiers.push(id);
          }
          if (dossiers.length) {
            notified = await notifyTopic(
              tx,
              NOTIFICATION_TOPICS.AR_RECALAGE,
              `${header.numero} — ${dossiers.length} AR client à recaler après validation du planning.`
            );
          }
        }
      }
    }

    await insertAuditLog(tx, audit, {
      action: `OF_PLANNING_${next}`,
      entity_type: "of_planning_version",
      entity_id: versionId,
      details: {
        of_id: ofId,
        of_numero: header.numero,
        from: version.statut,
        to: next,
        comment: input.comment,
        ar_dossiers: dossiers,
        notified_user_ids: notified,
      },
    });

    const refreshed = await repo.getPlanningVersion(ofId, versionId, tx);
    return { version: refreshed, arDossiers: dossiers, notified };
  });
}

/* ========================================================================== */
/* E) Dossiers d'AR à recaler                                                 */
/* ========================================================================== */

export async function listArDossiers(filters: { ofId?: number; statut?: string }) {
  if (filters.ofId !== undefined) await repo.readOfHeader(filters.ofId);
  return repo.listArDossiers(filters);
}

export async function createArDossier(
  ofId: number,
  input: {
    affaireId: number | null;
    previousDate: string | null;
    newDate: string | null;
    previousCadence: unknown;
    newCadence: unknown;
    quantite: number | null;
    motif: string;
    commentaire: string | null;
    ownerUserId: number | null;
  },
  actor: OfActor,
  audit: AuditContext,
  idempotencyKey: string | null
) {
  // Le domaine valide le motif et l'obligation de commentaire sur « Autre ».
  const validation = validateArRecalageInput({
    motif: input.motif,
    commentaire: input.commentaire,
  });
  if (!validation.valid) throw new HttpError(422, validation.code, validation.message);

  // Un dossier d'AR n'existe que si une date OU une cadence change réellement.
  // Sans cette garde, l'API laisserait ouvrir des dossiers vides, et la règle
  // « uniquement si un engagement client est affecté » serait contournable.
  const dateChanged =
    (input.previousDate ?? null) !== (input.newDate ?? null) &&
    (input.previousDate !== null || input.newDate !== null);
  const cadenceChanged =
    JSON.stringify(input.previousCadence ?? null) !== JSON.stringify(input.newCadence ?? null);
  if (!dateChanged && !cadenceChanged) {
    throw new HttpError(
      422,
      "AR_RECALAGE_NO_IMPACT",
      "Aucune date ni cadence client n'est modifiée : il n'y a pas d'AR à recaler."
    );
  }

  return repo.withOfTransaction(async (tx) => {
    if (idempotencyKey) {
      const existing = await repo.findArByIdempotencyKey(tx, idempotencyKey);
      if (existing) return { dossier: existing, replayed: true, notified: [] as number[] };
    }

    const header = await repo.readOfHeader(ofId, tx);
    const id = await repo.insertArDossier(tx, {
      clientId: header.client_id,
      commandeId: header.commande_id,
      affaireId: input.affaireId ?? header.affaire_id,
      ofId,
      planningVersionId: null,
      previousDate: input.previousDate,
      newDate: input.newDate,
      previousCadence: input.previousCadence,
      newCadence: input.newCadence,
      quantite: input.quantite,
      motif: input.motif,
      commentaire: input.commentaire,
      ownerUserId: input.ownerUserId,
      createdBy: actor.userId,
      idempotencyKey,
    });

    const notified = await notifyTopic(
      tx,
      NOTIFICATION_TOPICS.AR_RECALAGE,
      `${header.numero} — AR client à recaler (${input.motif}).`
    );

    await insertAuditLog(tx, audit, {
      action: "AR_RECALAGE_CREATE",
      entity_type: "ar_recalage_dossier",
      entity_id: id,
      details: {
        of_id: ofId,
        of_numero: header.numero,
        motif: input.motif,
        previous_date: input.previousDate,
        new_date: input.newDate,
        notified_user_ids: notified,
      },
    });

    const dossier = await repo.getArDossier(id, tx);
    return { dossier, replayed: false, notified };
  });
}

export async function updateArDossier(
  dossierId: string,
  input: { statut: ArRecalageStatut; ownerUserId: number | null; commentaire: string | null },
  actor: OfActor,
  audit: AuditContext
) {
  return repo.withOfTransaction(async (tx) => {
    const current = await repo.getArDossier(dossierId, tx);
    if (!current) throw new HttpError(404, "AR_RECALAGE_NOT_FOUND", "Dossier d'AR introuvable.");

    if (!canTransitionArStatut(current.statut as ArRecalageStatut, input.statut)) {
      throw new HttpError(
        422,
        "AR_RECALAGE_TRANSITION",
        `Transition d'AR interdite : ${current.statut} -> ${input.statut}.`
      );
    }

    await repo.updateArDossier(tx, {
      dossierId,
      expectedStatut: current.statut,
      statut: input.statut,
      ownerUserId: input.ownerUserId,
      commentaire: input.commentaire,
      userId: actor.userId,
    });

    await insertAuditLog(tx, audit, {
      action: "AR_RECALAGE_UPDATE",
      entity_type: "ar_recalage_dossier",
      entity_id: dossierId,
      details: { from: current.statut, to: input.statut, of_id: current.of_id },
    });

    const dossier = await repo.getArDossier(dossierId, tx);
    return { dossier };
  });
}

/* ========================================================================== */
/* F) Document d'OF — aperçu, émission, réimpression                          */
/* ========================================================================== */

/**
 * Construit le payload du document.
 *
 * UNE seule fonction produit le payload, et l'aperçu comme l'émission passent par
 * elle. C'est la garantie structurelle qu'aucune dérive n'est possible entre ce
 * qui est montré et ce qui est émis : il n'y a pas deux chemins à faire
 * concorder, il n'y en a qu'un.
 */
export async function buildDocumentPayload(
  ofId: number,
  args: { revisionId?: string | null; documentStatut: string; generatedAt: string; auteur: string | null }
): Promise<{ payload: OfDocumentPayload; revisionId: string }> {
  const header = await repo.readOfHeader(ofId);
  const revision = args.revisionId
    ? await repo.getRevision(ofId, args.revisionId)
    : await repo.getActiveRevision(ofId);

  if (!revision) {
    throw new HttpError(
      args.revisionId ? 404 : 409,
      args.revisionId ? "OF_REVISION_NOT_FOUND" : "OF_NO_ACTIVE_REVISION",
      args.revisionId
        ? "Révision introuvable sur cet ordre de fabrication."
        : "Cet OF n'a aucune révision active : aucun document ne peut être produit."
    );
  }

  const [operations, visaRows, familles, commercial] = await Promise.all([
    repo.listOperations(ofId, revision.id),
    repo.listVisas(ofId, revision.id),
    repo.readMachineFamilies(),
    repo.readCommercialContext(header),
  ]);

  const visas: Record<number, Record<string, unknown>> = {};
  for (const row of visaRows) {
    visas[row.phase] = {
      statut: row.statut,
      operateur: row.operateur,
      visaAt: row.visa_at,
      quantiteBonne: row.quantite_bonne,
      quantiteRebut: row.quantite_rebut,
      motifRebut: row.motif_rebut,
      visaOperateur: row.initials,
      visaControle: row.controle_initials,
      commentaire: row.comment,
    };
  }

  const snapshot = revision.snapshot as { matiere?: Record<string, unknown> | null } | null;
  const matiere = snapshot?.matiere ?? null;

  const payload = buildOfDocumentPayload({
    ofUuid: header.of_uuid,
    ofNumero: header.numero,
    revisionCode: revision.revision_code,
    revisionStatut: revision.statut,
    ofStatut: header.statut,
    documentStatut: args.documentStatut,
    snapshotId: revision.id,
    snapshotSha256: revision.snapshot_sha256,
    auteur: args.auteur,
    generatedAt: args.generatedAt,
    watermark: watermarkFor({
      revisionStatut: revision.statut,
      documentStatut: args.documentStatut,
    }),

    commandeNumero: header.commande_numero,
    clientCode: header.client_id,
    clientNom: header.client_nom,
    affaires: commercial.affaires,
    cadenceLivraison: commercial.cadenceLivraison,
    quantites: commercial.quantites,
    cadenceProduction: [],
    derniereFabrication: commercial.derniereFabrication,

    pieceReference: header.piece_reference,
    pieceDesignation: header.piece_designation,
    pieceIndice: header.piece_indice,
    gammeCode: header.gamme_code,
    gammeVersion: header.gamme_version,
    documentsAFournir: [],
    matiere: {
      reference: (matiere?.reference as string | null) ?? null,
      designation: (matiere?.designation as string | null) ?? null,
      nuance: (matiere?.nuance as string | null) ?? null,
    },
    decoupe: {
      dimensions: (matiere?.dimensions as string | null) ?? null,
      longueurBrutMm: (matiere?.longueurBrutMm as number | null) ?? null,
      longueurUtileMm: (matiere?.longueurUtileMm as number | null) ?? null,
      traitDeScieMm: (matiere?.traitDeScieMm as number | null) ?? null,
      chuteMm: (matiere?.chuteMm as number | null) ?? null,
      nombreBruts: (matiere?.nombreBruts as number | null) ?? null,
      piecesParBrut: (matiere?.piecesParBrut as number | null) ?? null,
      masseTotaleKg: (matiere?.masseTotaleKg as number | null) ?? null,
      unite: (matiere?.unite as string | null) ?? null,
      methodeCalcul: null,
    },

    operations,
    visas,
    familles,
  });

  return { payload, revisionId: revision.id };
}

/** Aperçu : aucune écriture, aucun effet. Le PDF est rendu et renvoyé tel quel. */
export async function previewDocument(
  ofId: number,
  revisionId: string | null,
  actor: OfActor,
  generatedAt: string
) {
  const { payload } = await buildDocumentPayload(ofId, {
    revisionId,
    documentStatut: "BROUILLON",
    generatedAt,
    auteur: actor.username,
  });
  const rendered = await renderOfDocument(payload);
  return { payload, ...rendered };
}

/**
 * Émet le document officiel.
 *
 * `expectedSnapshotSha256` est le verrou : c'est l'empreinte que l'aperçu a
 * montrée. Si l'OF a été révisé entre l'aperçu et l'émission, l'empreinte a
 * changé et l'émission est refusée par un 409 explicite — jamais par la
 * production silencieuse d'un document incohérent (critère d'acceptation #370).
 */
export async function emitDocument(
  ofId: number,
  input: { revisionId: string | null; expectedSnapshotSha256: string | null },
  actor: OfActor,
  audit: AuditContext,
  idempotencyKey: string | null,
  generatedAt: string
) {
  const { payload, revisionId } = await buildDocumentPayload(ofId, {
    revisionId: input.revisionId,
    documentStatut: "OFFICIEL",
    generatedAt,
    auteur: actor.username,
  });

  if (
    input.expectedSnapshotSha256 &&
    input.expectedSnapshotSha256 !== payload.snapshotSha256
  ) {
    throw new HttpError(
      409,
      "OF_DOCUMENT_SNAPSHOT_CHANGED",
      "L'ordre de fabrication a changé depuis l'aperçu : réactualiser avant d'émettre."
    );
  }

  const rendered = await renderOfDocument(payload);
  const payloadSha256 = hashDocumentPayload(payload);
  type PublicResult =
    | Readonly<{
        document: repo.OfDocumentRow;
        replayed: true;
        pdf: Buffer;
      }>
    | Readonly<{
        document: repo.OfDocumentRow;
        replayed: false;
        pdf: Buffer;
        archive: PublicOfDocumentArchiveResult;
      }>;
  type CommitContext = OfDocumentCommitContext<PublicResult>;

  let archiveOwnership: OfDocumentArchiveResult | null = null;
  try {
    const committed = await repo.withOfTransaction<CommitContext>(async (tx) => {
      if (idempotencyKey) {
        const existing = await repo.findDocumentByIdempotencyKey(tx, idempotencyKey);
        if (existing) {
          if (!existing.pdf_sha256 || existing.pdf_byte_size === null) {
            throw new HttpError(
              409,
              "OF_DOCUMENT_NO_PDF",
              "Le document idempotent n'a pas d'empreinte PDF exploitable."
            );
          }
          const publicResult: PublicResult = {
            document: existing,
            replayed: true,
            pdf: rendered.buffer,
          };
          return {
            publicResult,
            expectation: {
              documentId: existing.id,
              ofId: existing.of_id,
              revisionId: existing.revision_id,
              payloadSha256: existing.payload_sha256,
              pdfSha256: existing.pdf_sha256,
              pdfByteSize: existing.pdf_byte_size,
              gedDocumentId: existing.ged_document_id,
              gedVersionId: existing.ged_version_id,
              gedBlobStorageKey: existing.ged_version_id
                ? storageKeyForSha256(existing.pdf_sha256)
                : null,
              // A replay may target a GED version whose workflow status has
              // legitimately evolved since its original emission.
              gedVersionStatus: null,
              gedDocumentWasPreexisting: existing.ged_document_id !== null,
            },
            archiveOwnership: null,
          };
        }
      }

      await repo.lockOf(tx, ofId);

      // Double émission : une révision ne porte qu'UN document officiel. L'index
      // unique partiel le garantit, ce contrôle le dit clairement.
      const already = await repo.getOfficialDocument(ofId, revisionId, tx);
      if (already) {
        throw new HttpError(
          409,
          "OF_DOCUMENT_ALREADY_EMITTED",
          `Cette révision a déjà un document officiel (${already.id}). Utiliser la réimpression.`
        );
      }

      const existingGed = await repo.findExistingGedDocumentId(tx, ofId);
      const archive = await archiveOfDocument(tx, {
        ofNumero: payload.ofNumero,
        revisionCode: payload.revisionCode,
        pieceReference: payload.pieceReference,
        pdf: rendered.buffer,
        pdfSha256: rendered.sha256,
        existingGedDocumentId: existingGed,
        actorUserId: actor.userId,
        changeReason: `Émission ${payload.ofNumero} ${payload.revisionCode}`,
      }, (owned) => {
        archiveOwnership = owned;
      });
      archiveOwnership = archive;

      const document = await repo.insertDocument(tx, {
        ofId,
        revisionId,
        payload,
        payloadSha256,
        pdfSha256: rendered.sha256,
        pdfByteSize: rendered.byteSize,
        generatedAt,
        generatedBy: actor.userId,
        generatedByLabel: actor.username,
        statut: "OFFICIEL",
        gedDocumentId: archive.gedDocumentId,
        gedVersionId: archive.gedVersionId,
        idempotencyKey,
      });

      await insertAuditLog(tx, audit, {
        action: "OF_DOCUMENT_EMIT",
        entity_type: "of_document",
        entity_id: document.id,
        details: {
          of_id: ofId,
          of_numero: payload.ofNumero,
          revision_code: payload.revisionCode,
          payload_sha256: document.payload_sha256,
          pdf_sha256: rendered.sha256,
          template_version: payload.templateVersion,
          ged_archived: archive.archived,
          ged_skipped_reason: archive.skippedReason,
        },
      });

      const publicResult: PublicResult = {
        document,
        replayed: false,
        pdf: rendered.buffer,
        archive: publicOfDocumentArchiveResult(archive),
      };
      return {
        publicResult,
        expectation: {
          documentId: document.id,
          ofId,
          revisionId,
          payloadSha256,
          pdfSha256: rendered.sha256,
          pdfByteSize: rendered.byteSize,
          gedDocumentId: archive.gedDocumentId,
          gedVersionId: archive.gedVersionId,
          gedBlobStorageKey: archive.blobStorageKey,
          gedVersionStatus: archive.gedVersionId ? "BROUILLON" : null,
          gedDocumentWasPreexisting: existingGed !== null,
        },
        archiveOwnership: archive,
      };
    }, {
      afterConfirmedRollback: () => compensateOfDocumentArchive(archiveOwnership),
    });
    return committed.publicResult;
  } catch (error) {
    if (error instanceof repo.OfCommitUncertainError) {
      return reconcileOfDocumentCommit(error.transactionResult as CommitContext);
    }
    throw error;
  }
}

/**
 * Réimprime un document émis.
 *
 * L'archive GED est la source ; à défaut, le PDF est reconstruit depuis le
 * payload figé — déterministe par construction — puis son empreinte est comparée
 * à celle enregistrée. Un écart lève une erreur : mieux vaut refuser que servir
 * un document qui n'est pas celui qui a été émis.
 *
 * Une réimpression NE crée PAS de révision.
 */
export async function reprintDocument(
  ofId: number,
  documentId: string,
  audit: AuditContext
) {
  const document = await repo.getDocument(ofId, documentId);
  if (!document) {
    throw new HttpError(404, "OF_DOCUMENT_NOT_FOUND", "Document introuvable sur cet ordre de fabrication.");
  }
  if (!document.pdf_sha256) {
    throw new HttpError(409, "OF_DOCUMENT_NO_PDF", "Ce document n'a pas d'empreinte PDF enregistrée.");
  }

  let pdf = await readArchivedOfDocument(document.pdf_sha256);
  let source: "GED" | "PAYLOAD" = "GED";

  if (!pdf) {
    source = "PAYLOAD";
    const rendered = await renderOfDocument(document.payload as OfDocumentPayload);
    if (rendered.sha256 !== document.pdf_sha256) {
      throw new HttpError(
        500,
        "OF_DOCUMENT_REPRINT_MISMATCH",
        `La réimpression ne reproduit pas le document émis (attendu ${document.pdf_sha256}, obtenu ${rendered.sha256}).`
      );
    }
    pdf = rendered.buffer;
  }

  await repo.withOfTransaction(async (tx) => {
    await repo.bumpReprintCount(tx, { ofId, documentId });
    await insertAuditLog(tx, audit, {
      action: "OF_DOCUMENT_REPRINT",
      entity_type: "of_document",
      entity_id: documentId,
      details: { of_id: ofId, pdf_sha256: document.pdf_sha256, source },
    });
  });

  return { pdf, document, source };
}

export async function listDocuments(ofId: number) {
  await repo.readOfHeader(ofId);
  return repo.listDocuments(ofId);
}

/* ========================================================================== */
/* Utilitaires                                                                */
/* ========================================================================== */

/**
 * Résout les destinataires internes d'un sujet et prépare la notification.
 *
 * Aucune identité n'est écrite en dur : les destinataires viennent de
 * `notification_routing`, par rôle ou par identité désignée par un administrateur.
 * Aucun message client n'est envoyé — ces notifications sont internes.
 */
async function notifyTopic(
  tx: repo.DbQueryer,
  topic: string,
  message: string,
  dedupeParts: Array<string | number | null> = []
): Promise<number[]> {
  const [rules, candidates] = await Promise.all([
    repo.readNotificationRouting(topic, tx),
    repo.readNotificationCandidates(tx),
  ]);

  const recipients = resolveNotificationRecipients({
    topic,
    rules,
    candidates: candidates.map((c) => ({
      userId: c.userId,
      roles: [c.primaryRole, ...c.roles].filter((r): r is string => Boolean(r)),
    })),
  });

  // La rédaction est préparée et tracée ; l'acheminement reste du ressort du
  // canal de notification existant. Rien n'est envoyé au client.
  buildInternalNotification({
    topic,
    kind: topic.toLowerCase(),
    title: NOTIFICATION_TITLES[topic] ?? "Notification production",
    message,
    severity: "warning",
    actionUrl: null,
    actionLabel: null,
    payload: { recipients },
    dedupeKey: notificationDedupeKey(topic, ...dedupeParts),
  });
  return recipients;
}

/** Titres des sujets internes de ce chantier. Aucun n'est destiné au client. */
const NOTIFICATION_TITLES: Record<string, string> = {
  [NOTIFICATION_TOPICS.OF_TIME_VARIANCE]: "Dérive de temps : replanification proposée",
  [NOTIFICATION_TOPICS.OF_PLANNING_SUBMITTED]: "Planning soumis à validation",
  [NOTIFICATION_TOPICS.AR_RECALAGE]: "AR client à recaler",
};

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
