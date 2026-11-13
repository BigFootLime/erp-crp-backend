import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { insertAuditLog, repoCreateOrdreFabricationTx, type AuditContext } from "../repository/production.repository";
import { loadHistoricalPublishedTechnicalSnapshot } from "../domain/of-generation";
import type { WipMaterialCheckpointResolver, WipOpeningInput, WipOpeningReadModel, WipOpeningResumeResult } from "./wip-opening.types";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Matches data_cutover_wip_resumptions.quantity_launched numeric(14,4):
// ten integral digits and four fractional digits. Never let PostgreSQL round
// or fail after native OF creation has already begun.
const WIP_OPENING_QUANTITY_MAX = 9_999_999_999.9999;
const decimal = (value: number, label: string) => {
  // Floating-point literals such as 1.001 must not be rejected merely
  // because multiplication by 10_000 is represented as 10009.999999... .
  const rounded = Number.isFinite(value) ? Number(value.toFixed(4)) : value;
  const precisionError = Number.isFinite(value) ? Math.abs(value - rounded) : Infinity;
  const toleratedFloatError = Number.isFinite(value) ? Math.max(1e-9, Math.abs(value) * Number.EPSILON * 4) : 0;
  if (!Number.isFinite(value) || value < 0 || value > WIP_OPENING_QUANTITY_MAX || precisionError > toleratedFloatError) {
    throw new HttpError(422, "CUTOVER_WIP_QUANTITY_INVALID", `${label} doit être un nombre positif ou nul à quatre décimales au plus.`);
  }
};
const nonEmpty = (value: string | null | undefined, code: string, message: string) => {
  if (!value?.trim()) throw new HttpError(422, code, message);
  return value.trim();
};
const audit = (actorId: number): AuditContext => ({
  user_id: actorId, ip: null, user_agent: null, device_type: null, os: null, browser: null,
  path: "/administration/importation", page_key: "data-cutover", client_session_id: null,
});

type TechnicalSnapshotForWip = {
  version?: { manufacturing_mode?: unknown };
  nomenclature?: unknown[];
};

/**
 * The first native-resume slice validates purchased material lots only. It
 * must never pretend that already consumed assembly components were covered:
 * a component-bearing BOM therefore remains in preparation until the
 * dedicated component checkpoint exists.
 */
export function assertWipOpeningTechnicalSnapshot(snapshot: unknown) {
  const technical = snapshot && typeof snapshot === "object" ? snapshot as TechnicalSnapshotForWip : {};
  const bom = Array.isArray(technical.nomenclature) ? technical.nomenclature : [];
  if (bom.length > 0) {
    throw new HttpError(422, "CUTOVER_WIP_ASSEMBLY_COMPONENT_CHECKPOINT_REQUIRED", "Cet encours comporte des composants de nomenclature. Valider leurs lots et quantités repris avant de créer l'OF de continuité.");
  }
}

export function assertWipOpeningInput(input: WipOpeningInput) {
  for (const [value, label] of [[input.openingStateId, "l'état d'ouverture"], [input.batchId, "le lot"], [input.rowId, "la fiche"], [input.articleId, "l'article"], [input.pieceTechniqueId, "la pièce technique"], [input.historicalVersionId, "la version technique"]] as const) {
    if (!uuid.test(value)) throw new HttpError(422, "CUTOVER_WIP_IDENTIFIER_INVALID", `Identifiant invalide pour ${label}.`);
  }
  for (const [value, label] of [[input.affair.id, "la commande"], [input.affair.commandLineId, "la ligne de commande"]] as const) {
    if (!value) throw new HttpError(422, "CUTOVER_WIP_AFFAIR_INVALID", `${label} CERP doit être rapprochée explicitement.`);
    if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) throw new HttpError(422, "CUTOVER_WIP_AFFAIR_INVALID", `${label} CERP doit être rapprochée explicitement.`);
  }
  if (input.affair.type === "COMMANDE_CLIENT" && (!input.affair.deliveryAffairId || !/^\d+$/.test(input.affair.deliveryAffairId) || Number(input.affair.deliveryAffairId) <= 0 || !Number.isSafeInteger(Number(input.affair.deliveryAffairId)))) {
    throw new HttpError(422, "CUTOVER_WIP_AFFAIR_INVALID", "Une affaire de livraison CERP explicite est requise pour cette commande client.");
  }
  if (input.affair.type === "BESOIN_INTERNE" && input.affair.deliveryAffairId != null) throw new HttpError(422, "CUTOVER_WIP_AFFAIR_INVALID", "Un besoin interne ne doit pas être rattaché à une affaire de livraison.");
  if (!Number.isInteger(input.actorId) || input.actorId <= 0) throw new HttpError(422, "CUTOVER_WIP_ACTOR_INVALID", "L'auteur de la reprise est invalide.");
  decimal(input.quantityLaunched, "La quantité lancée");
  if (input.quantityLaunched <= 0) throw new HttpError(422, "CUTOVER_WIP_QUANTITY_REQUIRED", "La quantité physique restant dans l'encours doit être strictement positive.");
  if (input.historicalInitialQuantity != null) {
    decimal(input.historicalInitialQuantity, "La quantité initiale historique");
    if (input.historicalInitialQuantity < input.quantityLaunched) throw new HttpError(422, "CUTOVER_WIP_INITIAL_QUANTITY_INVALID", "La quantité historique ne peut pas être inférieure à la cohorte reprise.");
  }
  nonEmpty(input.unit, "CUTOVER_WIP_UNIT_REQUIRED", "Confirmer l'unité de la cohorte reprise.");
  nonEmpty(input.physicalBatchReference, "CUTOVER_WIP_BATCH_REFERENCE_REQUIRED", "Identifier la cohorte physique reprise.");
  if (input.checkpoints.length === 0) throw new HttpError(422, "CUTOVER_WIP_CHECKPOINT_REQUIRED", "Décrire chaque opération de la cohorte avant la reprise.");
  const phases = new Set<number>();
  let inProgress = 0;
  for (const point of input.checkpoints) {
    if (!Number.isInteger(point.phase) || point.phase < 0 || phases.has(point.phase)) throw new HttpError(422, "CUTOVER_WIP_PHASE_INVALID", "Chaque phase doit être présente une seule fois.");
    phases.add(point.phase);
    decimal(point.quantityGood, "La quantité bonne"); decimal(point.quantityScrap, "La quantité rebutée"); decimal(point.quantityPendingControl, "La quantité en attente de contrôle");
    if (point.quantityGood + point.quantityScrap + point.quantityPendingControl > input.quantityLaunched + 1e-9) throw new HttpError(422, "CUTOVER_WIP_CHECKPOINT_EXCEEDS_COHORT", "Le cumul d'une opération dépasse la cohorte physique reprise.");
    if (point.status === "NOT_STARTED" && point.quantityGood + point.quantityScrap + point.quantityPendingControl > 0) throw new HttpError(422, "CUTOVER_WIP_CHECKPOINT_STATE_INVALID", "Une opération non commencée ne peut pas porter de quantité historique.");
    // A setup, machine adjustment or first cut may be genuinely under way while
    // no physical part has yet been declared. The evidence is still mandatory;
    // only a completed historical phase requires a counted physical result.
    if (point.status === "COMPLETED" && point.quantityGood + point.quantityScrap + point.quantityPendingControl <= 0) throw new HttpError(422, "CUTOVER_WIP_CHECKPOINT_STATE_INVALID", "Une opération terminée doit être justifiée par une quantité confirmée.");
    if (point.status === "IN_PROGRESS") inProgress++;
    nonEmpty(point.evidenceReference, "CUTOVER_WIP_EVIDENCE_REQUIRED", "Chaque checkpoint d'opération exige un justificatif.");
  }
  if (inProgress > 1) throw new HttpError(422, "CUTOVER_WIP_SPLIT_REQUIRED", "Une cohorte avec plusieurs opérations simultanément en cours doit être séparée avant reprise.");
}

async function assertOpeningTx(tx: PoolClient, input: WipOpeningInput) {
  const opening = await tx.query<{ id: string }>(
    `SELECT state.id::text AS id
       FROM public.data_cutover_opening_states state
      WHERE state.id=$1::uuid AND state.batch_id=$2::uuid AND state.row_id=$3::uuid
        AND state.opening_kind='WIP' AND state.domain='WIP'
      FOR KEY SHARE`,
    [input.openingStateId, input.batchId, input.rowId]
  );
  if (!opening.rows[0]) throw new HttpError(409, "CUTOVER_WIP_OPENING_CHANGED", "L'état d'encours n'appartient plus au lot de reprise sélectionné.");
}

async function assertArticleMatchesTechnicalPieceTx(tx: PoolClient, input: WipOpeningInput) {
  const found = await tx.query<{ id: string }>(
    `SELECT article.id::text AS id
       FROM public.articles article
      WHERE article.id=$1::uuid AND article.piece_technique_id=$2::uuid
      FOR KEY SHARE`,
    [input.articleId, input.pieceTechniqueId]
  );
  if (!found.rows[0]) throw new HttpError(422, "CUTOVER_WIP_ARTICLE_TECHNICAL_MISMATCH", "L'article rapproché ne correspond pas à la pièce technique reprise.");
}

/**
 * Pure transactional preview guard shared by cutover preview and apply. It
 * locks the commercial target but creates no OF, stock movement, declaration
 * or checkpoint. The UI must only show a native resume as ready after this
 * returns successfully.
 */
export async function assertWipResumeTargetsTx(
  tx: PoolClient,
  input: Pick<WipOpeningInput, "affair" | "articleId" | "pieceTechniqueId" | "historicalVersionId" | "quantityLaunched" | "physicalBatchReference">
) {
  const commandLineId = input.affair.commandLineId;
  if (!commandLineId || !/^\d+$/.test(commandLineId) || !Number.isSafeInteger(Number(commandLineId))) {
    throw new HttpError(422, "CUTOVER_WIP_AFFAIR_INVALID", "La ligne de commande CERP doit être rapprochée explicitement.");
  }
  // One physical line may be split into several homogeneous WIP cohorts. A
  // transaction-scoped lock serializes their cumulative remaining-quantity
  // check. FOR KEY SHARE alone does not protect a sum of resumptions inserted
  // by another transaction.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('cerp-cutover-wip-line:' || $1::text, 1710))", [commandLineId]);
  const target = await tx.query<{ order_type: string; qty_remaining: number; qty_already_resumed: number; affair_reference: string | null }>(
    `SELECT command.order_type::text AS order_type,
            CASE WHEN command.order_type='INTERNE' THEN line.quantite
              ELSE COALESCE(allocation.qty_remaining, allocation.qty_to_produce) END::float8 AS qty_remaining,
            COALESCE((
              SELECT sum(resume.quantity_launched)::float8
                FROM public.data_cutover_wip_resumptions resume
                JOIN public.ordres_fabrication resumed_of ON resumed_of.id=resume.of_id
               WHERE resumed_of.commande_id=command.id
                 AND resumed_of.commande_ligne_id=line.id
                 AND resumed_of.affaire_id IS NOT DISTINCT FROM allocation.livraison_affaire_id
            ),0)::float8 AS qty_already_resumed,
            affair.reference::text AS affair_reference
       FROM public.commande_client command
       JOIN public.commande_ligne line ON line.commande_id=command.id
       LEFT JOIN public.commande_ligne_affaire_allocation allocation
         ON allocation.commande_id=command.id AND allocation.commande_ligne_id=line.id
       LEFT JOIN public.affaire affair ON affair.id=allocation.livraison_affaire_id
      WHERE command.id=$1::bigint
        AND line.id=$2::bigint
        AND line.article_id=$3::uuid
        AND line.piece_technique_id=$4::uuid
        AND line.piece_technique_version_id=$5::uuid
        AND (
          ($6::text='COMMANDE_CLIENT' AND allocation.livraison_affaire_id=$7::bigint AND affair.commande_id=command.id)
          OR ($6::text='BESOIN_INTERNE' AND command.order_type='INTERNE' AND allocation.id IS NULL)
        )
      FOR KEY SHARE OF command,line`,
    [input.affair.id, commandLineId, input.articleId, input.pieceTechniqueId, input.historicalVersionId, input.affair.type, input.affair.deliveryAffairId ?? null]
  );
  const row = target.rows[0];
  if (!row) throw new HttpError(422, "CUTOVER_WIP_TARGET_MISMATCH", "La commande, sa ligne, la version technique et l'affaire de livraison doivent être rapprochées avant la reprise.");
  if ((input.affair.type === "COMMANDE_CLIENT" && row.order_type === "INTERNE") || (input.affair.type === "BESOIN_INTERNE" && row.order_type !== "INTERNE")) {
    throw new HttpError(422, "CUTOVER_WIP_TARGET_TYPE_INVALID", "Le type de cible ne correspond pas à la commande native.");
  }
  // The reverse direction of the recursive-generation guard: never create a
  // resumed cohort beside an ordinary root OF for the same commercial target.
  // The opening must be reconciled with that OF explicitly; quantities are
  // never silently subtracted or mapped onto its routing.
  const ordinaryOf = await tx.query<{ id: string; numero: string }>(
    `SELECT ordre.id::text AS id,ordre.numero
       FROM public.ordres_fabrication ordre
       LEFT JOIN public.data_cutover_wip_resumptions resume ON resume.of_id=ordre.id
      WHERE ordre.commande_id=$1::bigint
        AND ordre.commande_ligne_id=$2::bigint
        AND ordre.affaire_id IS NOT DISTINCT FROM $3::bigint
        AND ordre.parent_of_id IS NULL
        AND ordre.statut::text<>'ANNULE'
        AND resume.id IS NULL
      ORDER BY ordre.id FOR KEY SHARE OF ordre`,
    [input.affair.id, commandLineId, input.affair.deliveryAffairId ?? null],
  );
  if (ordinaryOf.rows.length) {
    throw new HttpError(409, "CUTOVER_WIP_NORMAL_OF_EXISTS", "Un OF normal est déjà ouvert pour cette ligne. Vérifiez cet OF avant de reprendre cet encours.", {
      ordinary_of_references: ordinaryOf.rows.map((value) => value.numero),
    });
  }
  const duplicateBatch = await tx.query<{ id: string }>(
    `SELECT id::text AS id FROM public.data_cutover_wip_resumptions
      WHERE physical_batch_reference=$1
      FOR KEY SHARE`, [input.physicalBatchReference]
  );
  if (duplicateBatch.rows[0]) throw new HttpError(409, "CUTOVER_WIP_PHYSICAL_BATCH_DUPLICATE", "Cette cohorte physique a déjà été reprise dans un autre encours.");
  if (!Number.isFinite(row.qty_remaining) || row.qty_remaining < input.quantityLaunched || row.qty_already_resumed + input.quantityLaunched > row.qty_remaining + 1e-9) {
    throw new HttpError(409, "CUTOVER_WIP_REMAINING_QUANTITY_EXCEEDED", "La cohorte reprise dépasse le reliquat de la ligne et de son affaire. Vérifier les quantités avant de reprendre.");
  }
}

async function assertMaterialScopeTx(tx: PoolClient, input: WipOpeningInput, resolver: WipMaterialCheckpointResolver | undefined) {
  if (!resolver) throw new HttpError(409, "CUTOVER_WIP_MATERIAL_CHECK_UNAVAILABLE", "Le contrôle matière de reprise n'est pas encore disponible. Aucun OF n'a été créé.");
  const material = await resolver(tx, input);
  if (material.requiresMaterial) {
    if (input.materialScope !== "SINGLE_BATCH_VALIDATED" || !input.materialCheckpointId || !uuid.test(input.materialCheckpointId) || material.checkpointId !== input.materialCheckpointId) {
      throw new HttpError(422, "CUTOVER_WIP_MATERIAL_CHECKPOINT_REQUIRED", "La matière de cet encours doit être validée lot par lot avant la reprise.");
    }
    if (!input.materialEvidenceReference?.trim() || material.physicalBatchReference !== input.physicalBatchReference) {
      throw new HttpError(422, "CUTOVER_WIP_MATERIAL_BATCH_MISMATCH", "La cohorte physique validée ne correspond pas au checkpoint matière.");
    }
  } else if (input.materialScope !== "NONE" || input.materialCheckpointId) {
    throw new HttpError(422, "CUTOVER_WIP_MATERIAL_SCOPE_INVALID", "Une cohorte sans matière ne doit pas porter de checkpoint matière.");
  }
  return material;
}

async function assertCheckpointSequenceTx(tx: PoolClient, ofId: number, input: WipOpeningInput) {
  const operations = await tx.query<{ id: string; phase: number }>(
    `SELECT id::text AS id,phase::int AS phase FROM public.of_operations WHERE of_id=$1::bigint ORDER BY phase,id FOR KEY SHARE`, [ofId]
  );
  if (!operations.rows.length) throw new HttpError(422, "CUTOVER_WIP_GAMME_REQUIRED", "La version technique reprise ne contient aucune opération. Compléter la gamme avant reprise.");
  const byPhase = new Map(operations.rows.map((operation) => [operation.phase, operation]));
  if (byPhase.size !== input.checkpoints.length || input.checkpoints.some((point) => !byPhase.has(point.phase))) {
    throw new HttpError(422, "CUTOVER_WIP_OPERATION_MAPPING_INVALID", "Les checkpoints doivent couvrir exactement les opérations de la gamme reprise.");
  }
  const ordered = [...input.checkpoints].sort((a, b) => a.phase - b.phase);
  let seenOpen = false;
  for (const point of ordered) {
    if (seenOpen && point.status !== "NOT_STARTED") throw new HttpError(422, "CUTOVER_WIP_SPLIT_REQUIRED", "Les opérations déjà réalisées doivent former un préfixe continu de la gamme. Séparer les cohortes mélangées.");
    if (point.status !== "COMPLETED") seenOpen = true;
  }
  return { operations, byPhase };
}

export async function resumeWipOpeningTx(
  tx: PoolClient,
  input: WipOpeningInput,
  options: { resolveMaterialCheckpoint?: WipMaterialCheckpointResolver } = {}
): Promise<WipOpeningResumeResult> {
  assertWipOpeningInput(input);
  await assertOpeningTx(tx, input);
  await assertArticleMatchesTechnicalPieceTx(tx, input);
  const replay = await tx.query<{ id: string; of_id: string; numero: string }>(
    `SELECT resume.id::text AS id,resume.of_id::text AS of_id,ofx.numero
       FROM public.data_cutover_wip_resumptions resume JOIN public.ordres_fabrication ofx ON ofx.id=resume.of_id
      WHERE resume.opening_state_id=$1::uuid FOR KEY SHARE`, [input.openingStateId]
  );
  const fingerprint = createHash("sha256").update(JSON.stringify({ ...input, actorId: undefined })).digest("hex");
  if (replay.rows[0]) {
    const existing = await tx.query<{ source_hash: string; phase: number; operation_id: string }>(
      `SELECT resume.source_hash,checkpoint.phase,checkpoint.of_operation_id::text AS operation_id
         FROM public.data_cutover_wip_resumptions resume
         LEFT JOIN public.data_cutover_wip_operation_checkpoints checkpoint ON checkpoint.resumption_id=resume.id
        WHERE resume.id=$1::uuid ORDER BY checkpoint.phase`, [replay.rows[0].id]
    );
    if (existing.rows[0]?.source_hash !== fingerprint) throw new HttpError(409, "CUTOVER_WIP_IDEMPOTENCY_CONFLICT", "Cette cohorte a déjà été reprise avec un autre contenu.");
    return { resumptionId: replay.rows[0].id, ofId: Number(replay.rows[0].of_id), ofReference: replay.rows[0].numero, operationIdsByPhase: Object.fromEntries(existing.rows.map((row) => [row.phase, row.operation_id])) };
  }

  await assertWipResumeTargetsTx(tx, input);

  const technical = await loadHistoricalPublishedTechnicalSnapshot(tx, input.pieceTechniqueId, input.historicalVersionId, {
    preparation_evidence: { cutover_opening_state_id: input.openingStateId, physical_batch_reference: input.physicalBatchReference },
  });
  assertWipOpeningTechnicalSnapshot(technical.snapshot);
  await assertMaterialScopeTx(tx, input, options.resolveMaterialCheckpoint);
  const ofId = await repoCreateOrdreFabricationTx(tx, {
    body: {
      affaire_id: input.affair.deliveryAffairId ? Number(input.affair.deliveryAffairId) : null,
      commande_id: Number(input.affair.id),
      client_id: null,
      piece_technique_id: input.pieceTechniqueId,
      piece_technique_version_id: input.historicalVersionId,
      quantite_lancee: input.quantityLaunched,
      priority: "NORMAL",
      statut: "BROUILLON",
      notes: `Reprise encours ${input.physicalBatchReference}`,
    },
    audit: audit(input.actorId),
  }, { technical, forceDirect: true });
  const linkedOf = await tx.query(
    `UPDATE public.ordres_fabrication
        SET commande_ligne_id=$2::bigint
      WHERE id=$1::bigint AND commande_id=$3::bigint
        AND affaire_id IS NOT DISTINCT FROM $4::bigint`,
    [ofId, input.affair.commandLineId!, input.affair.id, input.affair.deliveryAffairId ?? null]
  );
  if (linkedOf.rowCount !== 1) throw new HttpError(409, "CUTOVER_WIP_TARGET_CHANGED", "La cible commerciale a changé pendant la reprise. Aucun OF n'a été conservé.");
  const mapped = await assertCheckpointSequenceTx(tx, ofId, input);
  const resumptionId = randomUUID();
  await tx.query(
    `INSERT INTO public.data_cutover_wip_resumptions(id,batch_id,row_id,opening_state_id,of_id,piece_technique_version_id,quantity_launched,unit,historical_initial_quantity,physical_batch_reference,material_scope,material_checkpoint_id,provenance,source_hash,created_by)
     VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::uuid,$7,$8,$9,$10,$11,$12::uuid,$13::jsonb,$14,$15)`,
    [resumptionId,input.batchId,input.rowId,input.openingStateId,ofId,input.historicalVersionId,input.quantityLaunched,input.unit,input.historicalInitialQuantity ?? null,input.physicalBatchReference,input.materialScope,input.materialCheckpointId ?? null,JSON.stringify({ source_system: input.sourceSystem, operation_key: input.operationKey, historical_initial_quantity: input.historicalInitialQuantity ?? null, article_id: input.articleId, affair: input.affair, material_evidence_reference: input.materialEvidenceReference ?? null }),fingerprint,input.actorId]
  );
  for (const point of input.checkpoints) {
    const operation = mapped.byPhase.get(point.phase)!;
    await tx.query(
      `INSERT INTO public.data_cutover_wip_operation_checkpoints(resumption_id,of_operation_id,phase,checkpoint_status,quantity_good,quantity_scrap,quantity_pending_control,unit,evidence_reference,created_by)
       VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [resumptionId,operation.id,point.phase,point.status,point.quantityGood,point.quantityScrap,point.quantityPendingControl,input.unit,point.evidenceReference,input.actorId]
    );
  }
  await tx.query(
    `INSERT INTO public.data_cutover_opening_links(opening_state_id,link_kind,native_target_type,native_target_id,native_target_reference,evidence_reference,created_by)
     SELECT $1::uuid,'NATIVE_TARGET','ORDRE_FABRICATION',$2::text,o.numero,$3,$4
       FROM public.ordres_fabrication o WHERE o.id=$2::bigint
     ON CONFLICT(opening_state_id,link_kind,native_target_type,native_target_id) DO NOTHING`,
    [input.openingStateId,ofId,`WIP resume ${input.physicalBatchReference}`,input.actorId]
  );
  await insertAuditLog(tx, audit(input.actorId), {
    action: "production.wip-opening.resume", entity_type: "ordres_fabrication", entity_id: String(ofId),
    details: { opening_state_id: input.openingStateId, resumption_id: resumptionId, historical_version_id: input.historicalVersionId, quantity_launched: input.quantityLaunched, physical_batch_reference: input.physicalBatchReference, no_pointage: true, no_stock_movement: true, no_material_debit: true, no_receipt: true },
  });
  const reference = (await tx.query<{ numero: string }>("SELECT numero FROM public.ordres_fabrication WHERE id=$1::bigint", [ofId])).rows[0]?.numero;
  if (!reference) throw new Error("CUTOVER_WIP_OF_READ_BACK_FAILED");
  return { resumptionId, ofId, ofReference: reference, operationIdsByPhase: Object.fromEntries(mapped.operations.rows.map((operation) => [operation.phase, operation.id])) };
}
