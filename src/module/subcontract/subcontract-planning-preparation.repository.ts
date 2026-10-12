import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ExternalServicePreparation } from './subcontract-flow.types';
import { subcontractSelection } from './subcontract-procurement.validators';
import { isSubcontractPieceUnit } from './subcontract-procurement.domain';

type Row = {
  id: string; operation_id: string; purchase_id: string; designation:string; quantity: number; snapshot: unknown;
  catalogue_id: string | null; supplier_id: string | null; supplier_name: string | null;
  unit: string | null; delay: number | null; order_line_ids: string[]; updated_at: string; packaged_quantity:number; supplier_active:boolean;
};
export type ExternalPreparationState = { preparations: ExternalServicePreparation[]; issues: string[] };

/** One batch for the visible operations. Canonical purchase selections stay authoritative;
 * inactive offers and stale quantities cannot silently become a new supplier promise. */
export async function readExternalPreparationsTx(tx: Pick<PoolClient,'query'>, operationIds: string[], additionalQuantity = 0) {
  if (!Number.isFinite(additionalQuantity) || additionalQuantity < 0) throw new RangeError('Invalid additional supplier quantity');
  const result = new Map<string,ExternalPreparationState>();
  if (!operationIds.length) return result;
  const installed = (await tx.query<{installed:boolean}>(`SELECT to_regclass('public.production_purchase_preparations') IS NOT NULL AS installed`)).rows[0]?.installed;
  if (!installed) return result;
  const rows = (await tx.query<Row>(`
    SELECT prep.id::text,op.id::text AS operation_id,prep.source_ref::text AS purchase_id,prep.designation,
      fab.quantite_lancee::float8 AS quantity,prep.snapshot,
      cat.id::text AS catalogue_id,COALESCE(f.id,prep.supplier_id)::text AS supplier_id,COALESCE(f.nom,f.raison_sociale) AS supplier_name,
      cat.unite AS unit,cat.delai_jours AS delay,prep.updated_at::text,(f.id IS NOT NULL) AS supplier_active,
      COALESCE((SELECT sum(work.qty_planned) FROM public.subcontract_work_packages work
        JOIN public.subcontract_purchase_origins origin ON origin.line_id=work.supplier_order_line_id
        WHERE work.of_operation_id=op.id AND work.status<>'CANCELLED'
          AND origin.preparation_snapshot->'purchase'->>'id'=prep.source_ref::text),0)::float8 AS packaged_quantity,
      COALESCE((SELECT jsonb_agg(origin.line_id::text ORDER BY origin.line_id)
        FROM public.subcontract_purchase_origins origin
        JOIN public.commande_fournisseur_ligne line ON line.id=origin.line_id
        JOIN public.commande_fournisseur purchase_order ON purchase_order.id=line.commande_id
        WHERE origin.operation_id=op.id AND origin.preparation_snapshot->'purchase'->>'id'=prep.source_ref::text
          AND line.statut_ligne='ACTIVE' AND purchase_order.statut<>'ANNULEE'),'[]'::jsonb) AS order_line_ids
    FROM public.production_purchase_preparations prep
    JOIN public.ordres_fabrication fab ON fab.id=prep.of_id
    JOIN public.of_operations op ON op.id::text=prep.snapshot->'service'->'selection'->>'operationId' AND op.of_id=fab.id
    LEFT JOIN public.fournisseur_catalogue cat ON cat.id::text=prep.snapshot->'service'->'selection'->>'catalogueId'
      AND cat.article_id=prep.article_id AND cat.actif
      AND(cat.valid_from IS NULL OR cat.valid_from<=current_date) AND(cat.valid_to IS NULL OR cat.valid_to>=current_date)
    LEFT JOIN public.fournisseurs f ON f.id=cat.fournisseur_id AND f.actif IS NOT FALSE
    WHERE op.id=ANY($1::uuid[]) AND prep.kind='PRESTATION' AND prep.status<>'PERIMEE'
      AND prep.technical_hash IS NOT DISTINCT FROM fab.technical_snapshot_sha256
      AND prep.technical_version_id IS NOT DISTINCT FROM fab.piece_technique_version_id
      AND prep.of_revision_id IS NOT DISTINCT FROM (SELECT r.id FROM public.of_revisions r WHERE r.of_id=fab.id AND r.statut='ACTIVE')
      AND op.status::text<>'CANCELLED'
      AND(op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE'))
    ORDER BY op.id,prep.source_ref,prep.id`,[operationIds])).rows;
  const required=(await tx.query<{operation_id:string;required_purchase:string;covered:boolean}>(`
    SELECT op.id::text AS operation_id,purchase->>'id' AS required_purchase,
      COALESCE((SELECT sum(work.qty_planned) FROM public.subcontract_work_packages work
        JOIN public.subcontract_purchase_origins origin ON origin.line_id=work.supplier_order_line_id
        WHERE work.of_operation_id=op.id AND work.status<>'CANCELLED'
          AND origin.preparation_snapshot->'purchase'->>'id'=purchase->>'id'),0)>=fab.quantite_lancee+$2::numeric AS covered
    FROM public.of_operations op JOIN public.ordres_fabrication fab ON fab.id=op.of_id,
      LATERAL jsonb_array_elements(COALESCE(fab.technical_snapshot->'preparation_evidence'->'purchases','[]'::jsonb)) purchase
    WHERE op.id=ANY($1::uuid[]) AND purchase->>'type_achat' IN('SOUS_TRAITANCE','TRAITEMENT')
      AND(purchase->>'gamme_operation_id'=op.source_piece_operation_id::text
        OR (purchase->>'gamme_operation_id' IS NULL AND NOT EXISTS(
          SELECT 1 FROM public.production_purchase_preparations other
          WHERE other.of_id=fab.id AND other.kind='PRESTATION' AND other.status<>'PERIMEE'
            AND other.source_ref::text=purchase->>'id'
            AND other.technical_hash IS NOT DISTINCT FROM fab.technical_snapshot_sha256
            AND other.technical_version_id IS NOT DISTINCT FROM fab.piece_technique_version_id
            AND other.of_revision_id IS NOT DISTINCT FROM (SELECT r.id FROM public.of_revisions r WHERE r.of_id=fab.id AND r.statut='ACTIVE')
            AND other.snapshot->'service'->'selection'->>'operationId' IS NOT NULL
            AND other.snapshot->'service'->'selection'->>'operationId'<>op.id::text)))
    ORDER BY op.id,purchase->>'id'`,[operationIds,additionalQuantity])).rows;
  for(const need of required) if(!need.covered&&!rows.some(row=>row.operation_id===need.operation_id&&row.purchase_id===need.required_purchase)) {
    const state=result.get(need.operation_id)??{preparations:[],issues:[]};
    state.issues.push('Complétez les prestations fournisseur de cette phase avant de planifier.');
    result.set(need.operation_id,state);
  }
  for (const row of rows) {
    let state=result.get(row.operation_id);
    if (!state) {state={preparations:[],issues:[]};result.set(row.operation_id,state);}
    const snapshot=row.snapshot as {service?:{selection?:unknown;forecastQuantity?:unknown}}|null;
    const selection=subcontractSelection.safeParse(snapshot?.service?.selection);
    const targetQuantity=row.quantity+additionalQuantity;
    const needsEstimate=row.packaged_quantity<targetQuantity;
    if (!selection.success || selection.data.purchaseId!==row.purchase_id || selection.data.operationId!==row.operation_id
      || !Number.isFinite(row.quantity) || row.quantity<=0 || !Number.isFinite(targetQuantity)
      || needsEstimate&&snapshot?.service?.forecastQuantity!==row.quantity) {
      state.issues.push('Actualisez la préparation fournisseur pour la quantité de cet OF.'); continue;
    }
    if (!row.supplier_id || needsEstimate&&(!row.supplier_active || !row.catalogue_id || !row.unit || !isSubcontractPieceUnit(row.unit))) {
      state.issues.push('Choisissez des conditions fournisseur actives, en pièces, pour prévoir la prestation.'); continue;
    }
    if (needsEstimate && !selection.data.due && (row.delay===null || !Number.isInteger(row.delay) || row.delay<0)) {
      state.issues.push('Renseignez la date de retour estimée ou le délai fournisseur.'); continue;
    }
    const preparation={id:row.id,operationId:row.operation_id,purchaseId:row.purchase_id,catalogueId:selection.data.catalogueId,label:row.designation,
      supplierId:row.supplier_id,supplierName:row.supplier_name??'Fournisseur',quantity:targetQuantity,
      due:selection.data.due,leadDays:row.delay,orderLineIds:row.order_line_ids};
    state.preparations.push({...preparation,version:createHash('sha256').update(JSON.stringify([preparation,row.updated_at])).digest('hex')});
  }
  return result;
}
