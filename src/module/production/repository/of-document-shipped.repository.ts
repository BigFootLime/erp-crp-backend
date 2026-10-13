import type { DbQueryer } from "./of-versioning.repository";

/** The delivered counter comes from dispatched delivery allocations, never from manufactured goods. */
export const OF_DOCUMENT_SHIPPED_QUANTITY_SQL = `
  SELECT COALESCE(SUM(item.quantite),0)::float8 AS shipped_quantity
    FROM public.ordres_fabrication courant
    JOIN public.commande_ligne ligne ON ligne.id = courant.commande_ligne_id
    JOIN public.commande_client commande ON commande.id = ligne.commande_id
      AND commande.client_id IS NOT DISTINCT FROM courant.client_id
    JOIN public.commande_ligne_affaire_allocation allocation
      ON allocation.commande_ligne_id = ligne.id
      AND allocation.commande_id = commande.id
      AND COALESCE(allocation.article_ref_id,ligne.article_id) = courant.article_id
    JOIN public.bon_livraison_ligne_allocations item
      ON item.commande_ligne_affaire_allocation_id = allocation.id
    JOIN public.bon_livraison_ligne bl_ligne ON bl_ligne.id = item.bon_livraison_ligne_id
    JOIN public.bon_livraison bl ON bl.id = bl_ligne.bon_livraison_id
   WHERE courant.id = $1
     AND courant.parent_of_id IS NULL
     AND bl.statut::text IN ('SHIPPED','DELIVERED')
`;

export async function readOfDocumentShippedQuantity(ofId: number, tx: DbQueryer): Promise<number> {
  const result = await tx.query(OF_DOCUMENT_SHIPPED_QUANTITY_SQL, [ofId]);
  const quantity = Number(result.rows[0]?.shipped_quantity ?? 0);
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error("Invalid OF document shipped quantity");
  return quantity;
}
