import type { DbQueryer } from "./of-versioning.repository";
import type { OfDocumentAffaire, OfQuantityInput } from "../domain/of-document";

/** Commercial demand, physical reservations and production commitments are separate, disjoint facts. */
export const OF_DOCUMENT_COMMERCIAL_SQL = `
WITH current_of AS (SELECT * FROM public.ordres_fabrication WHERE id=$1),
members AS (
  SELECT a.source_of_id FROM public.production_consolidations g
  JOIN public.production_consolidation_allocations a ON a.consolidation_id=g.id AND a.state='ACTIVE'
  JOIN current_of current ON current.id=g.producer_of_id WHERE g.state='ACTIVE'
), source_ids AS (
  SELECT source_of_id AS id FROM members
  UNION ALL SELECT id FROM current_of WHERE NOT EXISTS(SELECT 1 FROM members)
), sources AS (SELECT o.* FROM public.ordres_fabrication o JOIN source_ids source ON source.id=o.id),
lines AS (
  SELECT DISTINCT line.id,line.commande_id,line.article_id,line.quantite,command.numero,command.code_client AS customer_reference
  FROM sources source JOIN public.commande_ligne line ON line.id=source.commande_ligne_id
  JOIN public.commande_client command ON command.id=line.commande_id AND command.client_id IS NOT DISTINCT FROM source.client_id
  WHERE source.parent_of_id IS NULL AND command.order_type<>'INTERNE' AND line.article_id=source.article_id
), allocations AS (
  SELECT allocation.*,affaire.reference AS affaire_numero,
    COALESCE(promise.initial_due_date,line.delai_client)::text AS due_date
  FROM public.commande_ligne_affaire_allocation allocation JOIN lines demanded ON demanded.id=allocation.commande_ligne_id
  JOIN public.commande_ligne line ON line.id=demanded.id
  JOIN public.affaire affaire ON affaire.id=allocation.livraison_affaire_id
  LEFT JOIN public.delivery_promise_roots promise ON promise.allocation_id=allocation.id
  WHERE allocation.commande_id=demanded.commande_id AND COALESCE(allocation.article_ref_id,line.article_id)=demanded.article_id
    AND affaire.statut::text NOT IN('ANNULE','ANNULEE','CANCELLED') AND allocation.qty_ordered>0
), progress AS (
  SELECT allocation.*,COALESCE(reserved.quantity,0) AS reserved,COALESCE(shipped.quantity,0) AS shipped
  FROM allocations allocation
  LEFT JOIN LATERAL(SELECT sum(greatest(r.qty_reserved-r.qty_consumed,0)) AS quantity FROM public.stock_reservations r
    WHERE r.commande_ligne_affaire_allocation_id=allocation.id AND r.livraison_affaire_id=allocation.livraison_affaire_id
      AND r.status='ACTIVE') reserved ON true
  LEFT JOIN LATERAL(SELECT sum(item.quantite) AS quantity FROM public.bon_livraison_ligne_allocations item
    JOIN public.bon_livraison_ligne line ON line.id=item.bon_livraison_ligne_id
    JOIN public.bon_livraison bl ON bl.id=line.bon_livraison_id
    WHERE item.commande_ligne_affaire_allocation_id=allocation.id AND bl.statut::text IN('SHIPPED','DELIVERED')) shipped ON true
), candidate_base AS (
  SELECT DISTINCT o.* FROM public.ordres_fabrication o
  WHERE o.id IN(SELECT id FROM source_ids) OR EXISTS(
    SELECT 1 FROM sources source JOIN lines line ON line.id=source.commande_ligne_id
    WHERE o.commande_ligne_id=line.id AND o.piece_technique_id=source.piece_technique_id
      AND o.piece_technique_version_id IS NOT DISTINCT FROM source.piece_technique_version_id
      AND o.client_id IS NOT DISTINCT FROM source.client_id AND o.parent_of_id IS NOT DISTINCT FROM source.parent_of_id
      AND o.source_bom_line_id IS NOT DISTINCT FROM source.source_bom_line_id)
), relevant_ids AS (
  SELECT id FROM candidate_base
  UNION SELECT g.producer_of_id FROM public.production_consolidation_allocations a
    JOIN public.production_consolidations g ON g.id=a.consolidation_id AND g.state='ACTIVE'
    WHERE a.source_of_id IN(SELECT id FROM candidate_base) AND a.state='ACTIVE'
), qualified_outputs AS (
  SELECT of_id,sum(quantity) AS quantity FROM (
    SELECT receipt.of_id,assignment.quantity FROM public.of_receipts receipt
      JOIN public.production_receipt_lane_assignments assignment ON assignment.receipt_id=receipt.id
      JOIN public.stock_movements movement ON movement.id=receipt.stock_movement_id AND movement.status='POSTED'
      WHERE receipt.of_id IN(SELECT id FROM relevant_ids)
    UNION ALL SELECT g.producer_of_id,item.quantity FROM public.production_consolidation_receipt_allocations item
      JOIN public.production_consolidation_allocations allocation ON allocation.id=item.allocation_id
      JOIN public.production_consolidations g ON g.id=allocation.consolidation_id
      JOIN public.stock_movements movement ON movement.id=item.movement_id AND movement.status='POSTED'
      WHERE g.producer_of_id IN(SELECT id FROM relevant_ids)
        AND NOT EXISTS(SELECT 1 FROM public.of_receipts receipt JOIN public.production_receipt_lane_intents intent ON intent.receipt_id=receipt.id
          WHERE receipt.stock_movement_id=item.movement_id)
    UNION ALL SELECT receipt.of_id,receipt.qty_ok FROM public.of_receipts receipt
      JOIN public.stock_movements movement ON movement.id=receipt.stock_movement_id AND movement.status='POSTED'
      JOIN public.lots lot ON lot.id=receipt.lot_id AND lot.lot_status='LIBERE'
      WHERE receipt.of_id IN(SELECT id FROM relevant_ids)
        AND NOT EXISTS(SELECT 1 FROM public.production_receipt_lane_intents intent WHERE intent.receipt_id=receipt.id)
        AND NOT EXISTS(SELECT 1 FROM public.production_consolidation_receipt_allocations item WHERE item.movement_id=receipt.stock_movement_id)
  ) output GROUP BY of_id
), production_balances AS (
  SELECT o.id,greatest(0,(CASE WHEN o.statut::text='ANNULE' THEN 0
      WHEN o.statut::text IN('TERMINE','CLOTURE') THEN COALESCE(o.quantite_bonne,0)
      ELSE greatest(COALESCE(o.quantite_lancee,0)-COALESCE(o.quantite_rebut,0),0) END)-COALESCE(output.quantity,0)) AS remaining
  FROM public.ordres_fabrication o LEFT JOIN qualified_outputs output ON output.of_id=o.id WHERE o.id IN(SELECT id FROM relevant_ids)
), grouped_shares AS (
  SELECT allocation.source_of_id,g.producer_of_id,
    greatest(allocation.quantity-allocation.received_quantity,0) AS outstanding,
    COALESCE(sum(greatest(allocation.quantity-allocation.received_quantity,0)) OVER(PARTITION BY g.id ORDER BY allocation.due_date,allocation.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS earlier
  FROM public.production_consolidations g JOIN public.production_consolidation_allocations allocation
    ON allocation.consolidation_id=g.id AND allocation.state='ACTIVE'
  WHERE g.state='ACTIVE' AND g.producer_of_id IN(SELECT id FROM relevant_ids)
), commitments AS (
  SELECT candidate.id,CASE WHEN share.source_of_id IS NULL THEN COALESCE(own.remaining,0)
      ELSE least(share.outstanding,greatest(COALESCE(producer.remaining,0)-share.earlier,0)) END AS quantity
  FROM candidate_base candidate LEFT JOIN production_balances own ON own.id=candidate.id
  LEFT JOIN grouped_shares share ON share.source_of_id=candidate.id
  LEFT JOIN production_balances producer ON producer.id=share.producer_of_id
  WHERE NOT EXISTS(SELECT 1 FROM public.production_consolidations g WHERE g.producer_of_id=candidate.id AND g.state='ACTIVE')
), demand AS (
  SELECT COALESCE(sum(COALESCE(allocated.quantity,line.quantite)),0) AS quantity FROM lines line
    LEFT JOIN LATERAL(SELECT sum(qty_ordered) AS quantity FROM progress WHERE commande_ligne_id=line.id) allocated ON true
)
SELECT jsonb_build_object(
  'scope',CASE WHEN EXISTS(SELECT 1 FROM lines) THEN 'CUSTOMER'
    WHEN EXISTS(SELECT 1 FROM sources WHERE parent_of_id IS NOT NULL) THEN 'ASSEMBLY' ELSE 'INTERNAL' END,
  'commands',COALESCE((SELECT jsonb_agg(to_jsonb(command) ORDER BY command.id) FROM
    (SELECT DISTINCT commande_id AS id,numero,customer_reference FROM lines) command),'[]'),
  'affairs',COALESCE((SELECT jsonb_agg(jsonb_build_object('affaireId',livraison_affaire_id,'numero',affaire_numero,'delaiClient',due_date,'quantite',qty_ordered)
    ORDER BY due_date,livraison_affaire_id,id) FROM progress),'[]'),
  'sourceOrders',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',source.id,'number',source.numero,'launched',source.quantite_lancee,
    'remaining',COALESCE(commitment.quantity,0)) ORDER BY source.id) FROM sources source LEFT JOIN commitments commitment ON commitment.id=source.id),'[]'),
  'quantity',jsonb_build_object(
    'quantiteDemandee',CASE WHEN EXISTS(SELECT 1 FROM lines) THEN (SELECT quantity FROM demand) ELSE (SELECT quantite_lancee FROM current_of) END,
    'quantiteLivree',COALESCE((SELECT sum(shipped) FROM progress),0),
    'stockReserve',COALESCE((SELECT sum(reserved) FROM progress),0),
    'couvertAutresOf',COALESCE((SELECT sum(quantity) FROM commitments WHERE id NOT IN(SELECT id FROM source_ids)),0),
    'quantiteAffecteeCetOf',COALESCE((SELECT sum(quantity) FROM commitments WHERE id IN(SELECT id FROM source_ids)),0))) AS result
`;

export type OfDocumentCommercialProjection = {
  scope: "CUSTOMER" | "ASSEMBLY" | "INTERNAL";
  commands: Array<{ id: number; numero: string; customer_reference: string | null }>;
  affairs: OfDocumentAffaire[];
  sourceOrders: Array<{ id: number; number: string; launched: number; remaining: number }>;
  quantity: OfQuantityInput;
};

export async function readOfDocumentCommercial(tx: DbQueryer, ofId: number): Promise<OfDocumentCommercialProjection> {
  const result = (await tx.query<{ result: OfDocumentCommercialProjection }>(OF_DOCUMENT_COMMERCIAL_SQL, [ofId])).rows[0]?.result;
  if (!result) throw new Error("OF document commercial projection missing");
  for (const value of Object.values(result.quantity)) if (!Number.isFinite(value) || value < 0) throw new Error("Invalid OF document commercial quantity");
  return result;
}
