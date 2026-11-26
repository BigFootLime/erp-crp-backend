import type { PoolClient } from "pg";
import { generateTransactionalBusinessCode } from "../../../shared/codes/code-generator.service";
import { qualityRequestHash } from "../../qualite/domain/quality-policy";
import { applyMaterialLotDecision } from "../../qualite/repository/quality-material-lot-decision";
import { insertQualityEvent, requiresFormalReceiptPlan, type QualityActor } from "../../qualite/repository/quality-360.repository";
import { readSubcontractReturnSources } from "../../subcontract/subcontract-return-proof.repository";
import { convertedStockQuantity } from "../domain/receipt-unit-conversion";
import { assertReceiptReleaseAvailable } from "./receipt-quality-release.repository";

type Queryable = Pick<PoolClient, "query">;
type Sources = Awaited<ReturnType<typeof readSubcontractReturnSources>>;

export async function readSubcontractOperatorReleaseContext(tx: Queryable, lineId: string, sources: Sources) {
  const first = sources[0];
  if (!first || sources.some(source => source.ofId !== first.ofId || source.operationId !== first.operationId)) return null;
  const scope = (await tx.query<{
    lot_id: string; article_id: string; article_piece_id: string | null; article_family_id: string | null;
    of_piece_id: string; of_family_id: string | null; piece_version_id: string | null;
    supplier_id: string; phase: string; quantity: number; unit: string; receipt_unit: string; coefficient: number;
  }>(
    "SELECT lot.id::text AS lot_id,a.id::text AS article_id,a.piece_technique_id::text AS article_piece_id, " +
    "ap.famille_id::text AS article_family_id,o.piece_technique_id::text AS of_piece_id,pt.famille_id::text AS of_family_id, " +
    "o.piece_technique_version_id::text AS piece_version_id,r.fournisseur_id::text AS supplier_id, " +
    "op.phase::text,l.qty_received::float8 AS quantity,l.stock_unit AS unit,l.unite AS receipt_unit,l.stock_conversion_coef::float8 AS coefficient " +
    "FROM public.reception_fournisseur_lignes l JOIN public.receptions_fournisseurs r ON r.id=l.reception_id " +
    "JOIN public.commande_fournisseur_ligne cl ON cl.id=l.commande_fournisseur_ligne_id " +
    "JOIN public.ordres_fabrication o ON o.id=cl.of_id AND o.id=$2 " +
    "JOIN public.of_operations op ON op.id=$3::uuid AND op.of_id=o.id " +
    "JOIN public.pieces_techniques pt ON pt.id=o.piece_technique_id JOIN public.articles a ON a.id=l.article_id " +
    "LEFT JOIN public.pieces_techniques ap ON ap.id=a.piece_technique_id JOIN public.lots lot ON lot.id=l.lot_id AND lot.article_id=a.id " +
    "WHERE l.id=$1::uuid AND r.status IN ('OPEN','CLOSED') AND r.origin_type='SUPPLIER' AND r.confirmation_state IS DISTINCT FROM 'DRAFT' " +
    "AND lot.lot_status='QUARANTAINE' AND (lot.expiry_at IS NULL OR lot.expiry_at>now()) " +
    "AND l.processing_policy='PIECES_CONTROLE_EMBALLAGE' AND l.receipt_tool_id IS NULL AND l.stock_managed " +
    "AND l.receipt_quality_required AND NOT l.processing_reconciliation_required AND l.stock_unit=a.unite AND l.stock_conversion_coef>0 " +
    "AND cl.type='SOUS_TRAITANCE' AND cl.statut_ligne='ACTIVE' AND cl.exigences_qualite='[]'::jsonb " +
    "AND NOT EXISTS(SELECT 1 FROM unnest(cl.documents_attendus) doc WHERE upper(trim(doc)) NOT IN ('','BL','BON_LIVRAISON')) " +
    "AND NOT EXISTS(SELECT 1 FROM public.articles_traitement tr JOIN public.surface_finish_revisions fr ON fr.id=tr.finish_revision_id " +
    "WHERE tr.article_id=a.id AND fr.certificat_requis) " +
    "AND NOT EXISTS(SELECT 1 FROM public.piece_version_document_requirements d WHERE d.piece_technique_version_id=o.piece_technique_version_id " +
    "AND d.document_type_code NOT IN ('PLAN','BL','BON_LIVRAISON','FICHE_AUTOCONTROLE')) " +
    "AND NOT EXISTS(SELECT 1 FROM public.client_document_requirements d WHERE d.client_id=o.client_id " +
    "AND d.document_type_code NOT IN ('PLAN','BL','BON_LIVRAISON','FICHE_AUTOCONTROLE')) " +
    "AND NOT EXISTS(SELECT 1 FROM public.quality_control q WHERE (q.lot_id=lot.id OR q.reception_ligne_id=l.id " +
    "OR (q.source_type='LOT' AND q.source_id=lot.id::text)) AND q.status::text<>'CANCELLED') " +
    "AND NOT EXISTS(SELECT 1 FROM public.reception_incoming_inspections i WHERE i.reception_line_id=l.id) " +
    "AND NOT EXISTS(SELECT 1 FROM public.non_conformity nc WHERE nc.lot_id=lot.id OR nc.reception_ligne_id=l.id) " +
    "AND NOT EXISTS(SELECT 1 FROM public.reception_packaging p WHERE p.receipt_line_id=l.id AND p.voided_at IS NULL) " +
    "AND NOT EXISTS(SELECT 1 FROM public.reception_fournisseur_stock_receipts s WHERE s.reception_line_id=l.id) " +
    "AND NOT EXISTS(SELECT 1 FROM public.stock_batches b WHERE b.lot_id=lot.id AND b.qty_total>0) " +
    "AND NOT EXISTS(SELECT 1 FROM public.stock_movement_lines ml JOIN public.stock_movements m ON m.id=ml.movement_id " +
    "WHERE ml.lot_id=lot.id AND m.status='POSTED')",
    [lineId, first.ofId, first.operationId],
  )).rows[0];
  if (!scope || sources.some(source => source.unit.trim().toUpperCase() !== scope.receipt_unit.trim().toUpperCase()) ||
    Math.abs(sources.reduce((sum, source) => sum + source.quantity, 0) - scope.quantity) > 1e-9) return null;

  const anchor = { article_id: scope.article_id, fournisseur_id: scope.supplier_id, operation_code: scope.phase };
  if (await requiresFormalReceiptPlan(tx, { ...anchor, piece_technique_id: scope.of_piece_id,
    piece_version_id: scope.piece_version_id ?? undefined, famille_id: scope.of_family_id ?? undefined })) return null;
  if (scope.article_piece_id !== scope.of_piece_id && await requiresFormalReceiptPlan(tx, { ...anchor,
    piece_technique_id: scope.article_piece_id ?? undefined, famille_id: scope.article_family_id ?? undefined })) return null;
  return { ...scope, ofId: first.ofId, operationId: first.operationId };
}

export async function releaseVerifiedSubcontractReturn(tx: PoolClient, input: {
  lineId: string; idempotencyKey: string; scope: NonNullable<Awaited<ReturnType<typeof readSubcontractOperatorReleaseContext>>>;
  sources: Sources; actor: QualityActor;
}) {
  const { scope, lineId, sources, actor } = input;
  if (sources.some(source => source.recorded?.verdict !== "CONFORME" || source.recorded.appearance !== "OK")) return null;
  const qty = convertedStockQuantity(scope.quantity, scope.coefficient);
  await assertReceiptReleaseAvailable(tx, { id: lineId, unit: scope.unit, quantity: qty }, qty, scope.unit);
  const evidence = { lineId, lotId: scope.lot_id, ofId: scope.ofId, operationId: scope.operationId, quantity: qty, unit: scope.unit,
    sources: sources.map(source => ({ issueId: source.issueId, quantity: source.quantity, proofIds: source.proofs.map(proof => proof.controlId ?? proof.documentId) })) };
  const proofSha256 = qualityRequestHash("receptions.subcontract-return-release", evidence);
  const reference = await generateTransactionalBusinessCode(tx, { prefix: "CQ" });
  const { id: controlId, correlation_id: correlationId } = (await tx.query<{ id: string; correlation_id: string }>(
    "INSERT INTO public.quality_control(reference,control_type,status,result,controlled_by,validated_by,validation_date, " +
    "source_type,source_id,trigger_type,of_id,operation_id,piece_technique_id,lot_id,article_id,fournisseur_id,reception_ligne_id,unite, " +
    "qty_population,qty_controlled,qty_conforming,qty_released,verdict,verdict_computed,comments,created_by,updated_by) " +
    "VALUES($1,'RECEPTION','VALIDATED','OK',$2,$2,now(),'LOT',$6::uuid::text,'RECEPTION',$3,$4,$5,$6,$7,$8,$9,$10," +
    "$11,$11,$11,$11,'CONFORME','CONFORME','Contrôle opérateur du retour de traitement.',$2,$2) RETURNING id::text,correlation_id::text",
    [reference, actor.user_id, scope.ofId, scope.operationId, scope.of_piece_id, scope.lot_id, scope.article_id, scope.supplier_id, lineId, scope.unit, qty],
  )).rows[0];
  await tx.query(
    "INSERT INTO public.quality_control_points(quality_control_id,characteristic,characteristic_key,sample_no,value_boolean,result,measured_at,recorded_by) " +
    "VALUES($1::uuid,'Aspect du retour de traitement','RETOUR-TRAITEMENT-ASPECT',1,true,'OK',now(),$2)",
    [controlId, actor.user_id],
  );
  const { id: decisionId } = (await tx.query<{ id: string }>(
    "INSERT INTO public.quality_release_decision(quality_control_id,decision,object_type,object_id,qty,unite,verdict," +
    "decided_by,executed_by,preview_sha256,idempotency_key,correlation_id) " +
    "VALUES($1::uuid,'FULL','LOT',$2::uuid,$3,$4,'CONFORME',$5,$5,$6,$7,$8::uuid) RETURNING id::text",
    [controlId, scope.lot_id, qty, scope.unit, actor.user_id, proofSha256, input.idempotencyKey, correlationId],
  )).rows[0];
  await applyMaterialLotDecision(tx, {
    execution: { id: controlId, lot_id: scope.lot_id, source_type: "LOT", source_id: scope.lot_id, trigger_type: "RECEPTION", correlation_id: correlationId },
    decision: "FULL", released: qty, unit: scope.unit, actorId: actor.user_id, decisionId,
  });
  await insertQualityEvent(tx, { entity_type: "CONTROL", entity_id: controlId, event_type: "SUBCONTRACT_OPERATOR_RETURN_RELEASED",
    actor, old_values: null, new_values: { ...evidence, decisionId, proofSha256 }, idempotency_key: input.idempotencyKey,
    correlation_id: correlationId, rule_code: "SUBCONTRACT_RETURN_OPERATOR" });
  return { controlId, decisionId, releasedQuantity: qty };
}
