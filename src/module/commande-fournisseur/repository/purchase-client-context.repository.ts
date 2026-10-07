import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import type { PurchaseClientContext } from "../../fournisseurs/domain/client-supplier-approval";

/** Shared origin resolution for qualification, consultations and GED scope. */
export const PURCHASE_OF_ORIGIN_CTES = `active_lines AS (
  SELECT l.*,COALESCE(l.article_id,c.article_id) AS purchase_article FROM public.commande_fournisseur_ligne l
  LEFT JOIN public.fournisseur_catalogue c ON c.id=l.catalogue_id WHERE l.commande_id=$1::uuid AND l.statut_ligne='ACTIVE'
), origins AS (
  SELECT id AS line_id,of_id FROM active_lines WHERE of_id IS NOT NULL
  UNION SELECT l.id,b.of_id FROM active_lines l JOIN public.commande_fournisseur_ligne_besoin b ON b.ligne_id=l.id WHERE NOT b.annule AND b.of_id IS NOT NULL
  UNION SELECT l.id,b.besoin_of_id FROM active_lines l JOIN public.commande_fournisseur_ligne_besoin b ON b.ligne_id=l.id WHERE NOT b.annule AND b.besoin_of_id IS NOT NULL
  UNION SELECT l.id,p.of_id FROM active_lines l JOIN public.subcontract_purchase_origins p ON p.line_id=l.id
), effective_origins AS (
  SELECT o.line_id,COALESCE(a.source_of_id,o.of_id) AS of_id FROM origins o
  LEFT JOIN public.production_consolidations c ON c.producer_of_id=o.of_id AND c.state='ACTIVE'
  LEFT JOIN public.production_consolidation_allocations a ON a.consolidation_id=c.id AND a.state='ACTIVE'
)`;

export const PURCHASE_CLIENT_CONTEXT_SQL = `WITH ${PURCHASE_OF_ORIGIN_CTES}, contexts AS (
  SELECT l.id AS line_id,f.client_id,f.article_id AS product_article_id,l.purchase_article AS purchase_article_id,f.id AS of_id
  FROM active_lines l JOIN effective_origins e ON e.line_id=l.id JOIN public.ordres_fabrication f ON f.id=e.of_id
  UNION SELECT l.id,cc.client_id,NULL::uuid,l.purchase_article,NULL::bigint FROM active_lines l JOIN public.commande_client cc ON cc.id=l.commande_client_id
  UNION SELECT l.id,a.client_id,NULL::uuid,l.purchase_article,NULL::bigint FROM active_lines l JOIN public.affaire a ON a.id=l.affaire_id
) SELECT DISTINCT line_id::text,client_id,product_article_id::text,purchase_article_id::text,of_id::int
  FROM contexts WHERE client_id IS NOT NULL ORDER BY client_id,line_id,of_id NULLS LAST,product_article_id NULLS LAST LIMIT 5001`;
export async function readPurchaseClientContextsTx(
  tx: Pick<PoolClient, "query">,
  orderId: string,
): Promise<Omit<PurchaseClientContext, "domains">[]> {
  const rows = (
    await tx.query<Omit<PurchaseClientContext, "domains">>(
      PURCHASE_CLIENT_CONTEXT_SQL,
      [orderId],
    )
  ).rows;
  if (rows.length > 5000)
    throw new HttpError(
      409,
      "CLIENT_APPROVAL_CONTEXT_LIMIT",
      "La commande regroupe trop de besoins pour vérifier ses agréments. Scindez-la avant engagement.",
    );
  return rows;
}
