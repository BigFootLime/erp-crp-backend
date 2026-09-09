import type { PoolClient } from 'pg';
/** Received surplus is an allocation fact, never an additional stock balance.
 * Purchase allocation offsets are expressed in stock units, including NONE. */
export async function readOffStockSurplusTx(tx:Pick<PoolClient,'query'>,receiptLineIds:string[]){
  if(!receiptLineIds.length)return new Map<string,number>();
  const rows=(await tx.query<{id:string;unallocated:number}>(`WITH deliveries AS(
    SELECT r.id,r.commande_fournisseur_ligne_id AS line_id,COALESCE(r.stock_conversion_coef,l.coef_conversion,1) AS coefficient,
      r.qty_received*COALESCE(r.stock_conversion_coef,l.coef_conversion,1) AS quantity,
      COALESCE(sum(r.qty_received*COALESCE(r.stock_conversion_coef,l.coef_conversion,1)) OVER(PARTITION BY r.commande_fournisseur_ligne_id ORDER BY r.created_at,r.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS start
    FROM public.reception_fournisseur_lignes r JOIN public.commande_fournisseur_ligne l ON l.id=r.commande_fournisseur_ligne_id
    WHERE r.commande_fournisseur_ligne_id IN(SELECT commande_fournisseur_ligne_id FROM public.reception_fournisseur_lignes WHERE id=ANY($1::uuid[]) AND NOT stock_managed)
  ), assignments AS(
    SELECT b.ligne_id,CASE WHEN b.besoin_type='OF_MATERIAL' THEN b.quantite_couverte ELSE b.quantite_couverte*COALESCE(l.coef_conversion,1) END AS quantity,
      COALESCE(b.stock_receipt_offset,sum(CASE WHEN b.besoin_type='OF_MATERIAL' THEN b.quantite_couverte ELSE b.quantite_couverte*COALESCE(l.coef_conversion,1) END) OVER(PARTITION BY b.ligne_id ORDER BY b.created_at,b.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS start
    FROM public.commande_fournisseur_ligne_besoin b JOIN public.commande_fournisseur_ligne l ON l.id=b.ligne_id
    WHERE NOT b.annule AND b.ligne_id IN(SELECT line_id FROM deliveries)
  ) SELECT d.id::text,(GREATEST(0,d.quantity-COALESCE(sum(GREATEST(0,LEAST(d.start+d.quantity,a.start+a.quantity)-GREATEST(d.start,a.start))),0))/d.coefficient)::float8 AS unallocated
    FROM deliveries d LEFT JOIN assignments a ON a.ligne_id=d.line_id WHERE d.id=ANY($1::uuid[])
    GROUP BY d.id,d.quantity,d.coefficient`,[receiptLineIds])).rows;
  return new Map(rows.map(r=>[r.id,r.unallocated]));
}
