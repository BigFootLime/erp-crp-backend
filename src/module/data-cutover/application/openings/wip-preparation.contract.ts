import type { PoolClient } from "pg";
import { HttpError } from "../../../../utils/httpError";
import { canonicalizeStockUnitCode } from "../../../../shared/stock-unit";
import { loadHistoricalPublishedTechnicalSnapshot } from "../../../production/domain/of-generation";
import type { WipOpeningCheckpointInput, WipOpeningInput } from "../../../production/wip-opening/wip-opening.types";
import type { CutoverRow } from "../../types/data-cutover.types";
import type { CutoverTarget } from "./openings.contract";
import { readWipMaterialRequirementsTx } from "../../../production/wip-material-opening/wip-material-opening.repository";
import { assertWipOpeningTechnicalSnapshot } from "../../../production/wip-opening/wip-opening.repository";

type PublishedVersion = { id: string; plan_reference: string | null; indice: string | null; version_interne: number; statut: string };
type Phase = { phase: number; designation: string | null };
type Snapshot = { version?: { plan_reference?: string | null; indice_externe?: string | null }; operations?: Array<{ phase?: unknown; designation?: unknown }> };
type MaterialRequirement = Awaited<ReturnType<typeof readWipMaterialRequirementsTx>>["expectedRequirements"][number] & { compatibleLots: CompatibleLot[] };
type CompatibleLot = { id: string; reference: string; supplierReference: string | null; qualityStatus: "LIBERE"; ownerClientId: string | null };
const WIP_COHORT_MAX = 9_999_999_999.999;
const text = (row: CutoverRow, field: string) => typeof row.values[field] === "string" ? String(row.values[field]).trim() : "";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Only expose lots that can actually be selected for this WIP material
 * checkpoint.  This remains read-only and intentionally excludes stock cost,
 * supplier and availability data: historical consumption is recorded, never
 * debited again here. */
async function readCompatibleMaterialLotsTx(tx: PoolClient, requirement: Awaited<ReturnType<typeof readWipMaterialRequirementsTx>>["expectedRequirements"][number]): Promise<CompatibleLot[]> {
  const result = await tx.query<{ id: string; reference: string; supplier_reference: string | null; owner_client_id: string | null }>(
    `SELECT lot.id::text AS id,lot.lot_code AS reference,lot.supplier_lot_code AS supplier_reference,
            lot.client_proprietaire_id::text AS owner_client_id
       FROM public.lots lot
       JOIN public.articles article ON article.id=lot.article_id
      WHERE lot.article_id=$1::uuid
        AND upper(btrim(COALESCE(article.unite,'')))=upper(btrim($2))
        AND lot.client_proprietaire_id IS NOT DISTINCT FROM $3::varchar
        AND lot.lot_status='LIBERE'
      ORDER BY lot.lot_code,lot.id
      LIMIT 50`,
    [requirement.articleId, requirement.unit, requirement.expectedOwnerClientId],
  );
  return result.rows.map((lot) => ({ id: lot.id, reference: lot.reference, supplierReference: lot.supplier_reference, qualityStatus: "LIBERE", ownerClientId: lot.owner_client_id }));
}

/** No historical execution is inferred from an archived routing. The caller
 * supplies the current phase and an explicit workshop confirmation for this
 * physical cohort, backed by the same dated evidence for its checkpoints. */
export function buildConfirmedWipCheckpoints(row: CutoverRow, phases: Phase[]): WipOpeningCheckpointInput[] {
  const quantityText = String(row.values.quantityRemaining ?? "").replace(",", ".");
  const quantity = Number(quantityText);
  if (!/^\d{1,10}(?:\.\d{1,3})?$/.test(quantityText) || !Number.isFinite(quantity) || quantity <= 0 || quantity > WIP_COHORT_MAX) throw new HttpError(422, "CUTOVER_WIP_COHORT_REQUIRED", "Confirmer la quantité physique encore en fabrication dans cette cohorte, avec trois décimales maximum sans arrondi automatique.");
  const phaseText = String(row.values.currentPhase ?? "");
  const phase = Number(phaseText);
  if (!/^(?:0|[1-9]\d{0,8})$/.test(phaseText) || !phases.some((item) => item.phase === phase)) throw new HttpError(422, "CUTOVER_WIP_PHASE_REQUIRED", "La phase choisie n'appartient pas à la gamme publiée utilisée.");
  if (!phases.length || new Set(phases.map((item) => item.phase)).size !== phases.length) throw new HttpError(422, "CUTOVER_WIP_GAMME_REQUIRED", "Confirmer une gamme avec des phases distinctes avant de reprendre la fabrication.");
  if (phases.some((item) => item.phase < phase) && row.values.previousOperationsConfirmed !== true) throw new HttpError(422, "CUTOVER_WIP_SEQUENCE_CONFIRMATION_REQUIRED", "L'atelier doit confirmer que toute cette cohorte a franchi les phases précédentes. Séparer les groupes si leur avancement diffère.");
  const evidence = text(row, "evidenceReference");
  if (!evidence || !text(row, "workshopValidator")) throw new HttpError(422, "CUTOVER_WIP_EVIDENCE_REQUIRED", "Identifier le référent atelier et la preuve de l'avancement constaté.");
  const state = text(row, "phaseState");
  if (!["NOT_STARTED", "IN_PROGRESS", "PAUSED", "COMPLETED"].includes(state)) throw new HttpError(422, "CUTOVER_WIP_CHECKPOINT_STATE_INVALID", "Confirmer l'état de la phase actuelle.");
  if (state === "COMPLETED" && phase === Math.max(...phases.map((item) => item.phase))) throw new HttpError(422, "CUTOVER_WIP_FINISHED_STOCK_REQUIRED", "Cette cohorte a terminé sa dernière phase. Faire confirmer son contrôle et sa reprise dans le stock de pièces finies plutôt que créer un OF d'encours.");
  return [...phases].sort((a, b) => a.phase - b.phase).map((item) => {
    const completed = item.phase < phase || (item.phase === phase && state === "COMPLETED");
    return {
      phase: item.phase,
      status: completed ? "COMPLETED" : item.phase === phase && (state === "IN_PROGRESS" || state === "PAUSED") ? "IN_PROGRESS" : "NOT_STARTED",
      quantityGood: completed ? quantity : 0,
      quantityScrap: 0,
      quantityPendingControl: 0,
      evidenceReference: evidence,
    };
  });
}

export async function readWipPreparationContextTx(tx: PoolClient, row: CutoverRow, chosenVersionId?: string) {
  const articleId = text(row, "articleTargetId");
  if (!uuid.test(articleId)) return { article_ready: false as const, versions: [], selected_version: null, phases: [] as Phase[], piece_technique_id: null, article_id: null, unit: null };
  const article = (await tx.query<{ id: string; piece_technique_id: string | null; unite: string | null }>(
    "SELECT id::text AS id,piece_technique_id::text AS piece_technique_id,unite FROM public.articles WHERE id=$1::uuid FOR KEY SHARE", [articleId]
  )).rows[0];
  if (!article?.piece_technique_id) throw new HttpError(422, "CUTOVER_WIP_ARTICLE_TECHNICAL_MISMATCH", "Rapprocher un article fabriqué relié à sa pièce technique avant de préparer cet encours.");
  const versions = (await tx.query<PublishedVersion>(
    "SELECT id::text AS id,plan_reference,indice,version_interne,statut FROM public.piece_technique_versions WHERE piece_technique_id=$1::uuid AND statut IN ('APPLICABLE','OBSOLETE') ORDER BY version_interne DESC,id", [article.piece_technique_id]
  )).rows;
  const selectedId = chosenVersionId ?? text(row, "historicalVersionId");
  const selected = selectedId ? versions.find((version) => version.id === selectedId) : null;
  if (selectedId && !selected) throw new HttpError(422, "CUTOVER_WIP_VERSION_MISMATCH", "Choisir une version publiée de la pièce technique correspondant à cet article.");
  const technical = selected ? await loadHistoricalPublishedTechnicalSnapshot(tx, article.piece_technique_id, selected.id) : null;
  const snapshot = technical?.snapshot as Snapshot | undefined;
  let resumptionBlocker: { code: string; message: string } | null = null;
  if (technical) try { assertWipOpeningTechnicalSnapshot(technical.snapshot); } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    resumptionBlocker = { code: error.code, message: error.message };
  }
  const phases = (snapshot?.operations ?? []).map((operation) => ({ phase: Number(operation.phase), designation: typeof operation.designation === "string" ? operation.designation : null }));
  if (phases.some((phase) => !Number.isSafeInteger(phase.phase) || phase.phase < 0)) throw new HttpError(422, "CUTOVER_WIP_GAMME_REQUIRED", "La gamme contient une phase qui doit être corrigée avant reprise.");
  let material: { ready: boolean; requirements: MaterialRequirement[]; message: string | null } = { ready: false, requirements: [], message: "Choisir la version technique et confirmer la quantité de cohorte pour préparer la matière." };
  if (selected) {
    try {
      const quantityText = String(row.values.quantityRemaining ?? "").replace(",", ".");
      if (!/^\d{1,10}(?:\.\d{1,3})?$/.test(quantityText) || Number(quantityText) <= 0 || Number(quantityText) > WIP_COHORT_MAX) throw new HttpError(422, "CUTOVER_WIP_COHORT_REQUIRED", "Confirmer une quantité de cohorte strictement positive avec trois décimales maximum.");
      const expected = await readWipMaterialRequirementsTx(tx, { articleId: article.id, pieceTechniqueId: article.piece_technique_id, historicalVersionId: selected.id, quantityLaunched: Number(quantityText) });
      material = { ready: true, requirements: await Promise.all(expected.expectedRequirements.map(async (requirement) => ({ ...requirement, compatibleLots: await readCompatibleMaterialLotsTx(tx, requirement) }))), message: null };
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      material.message = error.message;
    }
  }
  const orderId = text(row, "affairTargetId");
  const demand = /^[1-9]\d{0,14}$/.test(orderId) ? (await tx.query<{ order_type: string }>("SELECT order_type FROM public.commande_client WHERE id=$1::bigint", [orderId])).rows[0] : null;
  const demandLines = demand ? (await tx.query<{ id: string; code: string; designation: string }>(
    "SELECT l.id::text AS id,COALESCE(l.code_piece,l.id::text) AS code,l.designation FROM public.commande_ligne l WHERE l.commande_id=$1::bigint AND l.article_id=$2::uuid AND ($3::uuid IS NULL OR l.piece_technique_version_id=$3::uuid) ORDER BY l.id", [orderId, article.id, selected?.id ?? null]
  )).rows : [];
  const affairs = demand && demand.order_type !== "INTERNE" ? (await tx.query<{ line_id: string; id: string; reference: string; remaining: number; to_produce: number }>(
    `SELECT allocation.commande_ligne_id::text AS line_id,affair.id::text AS id,affair.reference,
      allocation.qty_remaining::float8 AS remaining,allocation.qty_to_produce::float8 AS to_produce
     FROM public.commande_ligne_affaire_allocation allocation
     JOIN public.commande_ligne line ON line.id=allocation.commande_ligne_id AND line.commande_id=allocation.commande_id
     JOIN public.affaire affair ON affair.id=allocation.livraison_affaire_id AND affair.commande_id=allocation.commande_id
     WHERE allocation.commande_id=$1::bigint AND line.article_id=$2::uuid AND ($3::uuid IS NULL OR line.piece_technique_version_id=$3::uuid) ORDER BY line.id,affair.id`, [orderId, article.id, selected?.id ?? null]
  )).rows : [];
  return {
    article_ready: true as const, article_id: article.id, piece_technique_id: article.piece_technique_id,
    unit: canonicalizeStockUnitCode(article.unite), versions, selected_version: selected ?? null, phases, material, resumption_blocker: resumptionBlocker,
    demand_type: demand?.order_type ?? null,
    demand_lines: demandLines.map((line) => ({ ...line, affairs: affairs.filter((affair) => affair.line_id === line.id).map(({ line_id: _lineId, ...affair }) => affair) })),
  };
}

export async function prepareNativeWipInputTx(tx: PoolClient, row: CutoverRow, targets: { article: CutoverTarget; affair: CutoverTarget }, actorId: number, sourceSystem: string, operationKey: string): Promise<Omit<WipOpeningInput, "openingStateId" | "materialScope" | "materialCheckpointId">> {
  const versionId = text(row, "historicalVersionId");
  if (!uuid.test(versionId)) throw new HttpError(422, "CUTOVER_WIP_VERSION_REQUIRED", "Choisir la version technique publiée réellement utilisée.");
  const context = await readWipPreparationContextTx(tx, { ...row, values: { ...row.values, articleTargetId: targets.article.id } }, versionId);
  if (!context.article_ready || !context.piece_technique_id || !context.selected_version) throw new HttpError(422, "CUTOVER_WIP_VERSION_REQUIRED", "Compléter le rapprochement de l'article et de sa version publiée.");
  if (context.resumption_blocker) throw new HttpError(409, context.resumption_blocker.code, context.resumption_blocker.message);
  const sourcePlan = text(row, "planReference"), sourceRevision = text(row, "technicalRevision");
  if (!sourcePlan || sourcePlan !== context.selected_version.plan_reference || (row.values.withoutRevision === true ? Boolean(context.selected_version.indice) || Boolean(sourceRevision) : !sourceRevision || sourceRevision !== context.selected_version.indice)) throw new HttpError(422, "CUTOVER_WIP_REVISION_MISMATCH", "Le plan et son indice confirmés doivent correspondre à la version publiée utilisée par cet encours.");
  const unit = canonicalizeStockUnitCode(text(row, "unit"));
  if (!unit || unit !== context.unit) throw new HttpError(422, "CUTOVER_WIP_UNIT_MISMATCH", "La cohorte doit utiliser l'unité de l'article CERP. Aucune conversion automatique n'est effectuée.");
  const physicalBatchReference = text(row, "physicalBatchReference");
  if (!physicalBatchReference) throw new HttpError(422, "CUTOVER_WIP_PHYSICAL_BATCH_REQUIRED", "Identifier le lot physique encore en fabrication.");
  const affairType = ["INTERNAL_DEMAND", "BESOIN_INTERNE"].includes(targets.affair.type) ? "BESOIN_INTERNE" : "COMMANDE_CLIENT";
  return {
    batchId: row.batch_id, rowId: row.id, sourceSystem, operationKey, articleId: targets.article.id,
    affair: { type: affairType, id: targets.affair.id, commandLineId: text(row, "commandeLigneId") || null, deliveryAffairId: text(row, "livraisonAffaireId") || null }, pieceTechniqueId: context.piece_technique_id, historicalVersionId: versionId,
    quantityLaunched: Number(String(row.values.quantityRemaining).replace(",", ".")), unit, physicalBatchReference,
    materialEvidenceReference: text(row, "evidenceReference"), checkpoints: buildConfirmedWipCheckpoints(row, context.phases), actorId,
  };
}
