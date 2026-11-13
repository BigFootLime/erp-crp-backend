import pool from "../../../config/database";
import { deliveryContractGroupKey } from "../domain/delivery-contract-boundary";
import type { DeliveryAffairsQuery } from "../validators/delivery-affairs.validators";
// Start from canonical delivery allocations, never from reservations or current PTs.
// One statement keeps counters, page and total on the same PostgreSQL snapshot.
export const DELIVERY_AFFAIRS_SQL = `
WITH sources AS (
  SELECT allocation.id, allocation.commande_id, allocation.commande_ligne_id,
    allocation.livraison_affaire_id, allocation.qty_ordered,
    command.numero AS commande_numero, command.code_client AS customer_order_reference,
    command.client_id, command.order_type, customer.company_name AS client_name,
    customer.client_code, COALESCE(command.destinataire_id,customer.delivery_address_id)::text AS delivery_address_id,
    affaire.reference AS affaire_reference, affaire.delivery_readiness_state,
    article.id::text AS article_id, COALESCE(article.code,line.code_piece) AS article_code,
    COALESCE(line.designation,article.designation) AS designation,
    line.unite AS unit, technical.indice AS article_indice,
    promise.initial_due_date::text AS ar_due_date, line.delai_client::text AS requested_due_date,
    COALESCE(call.contract_id,legacy.contract_id) AS contract_id,
    COALESCE(call.contract_snapshot->>'reference',legacy.contract_snapshot->>'reference') AS contract_reference
  FROM public.commande_ligne_affaire_allocation allocation
  JOIN public.commande_client command ON command.id=allocation.commande_id
  JOIN public.commande_ligne line ON line.id=allocation.commande_ligne_id AND line.commande_id=command.id
  JOIN public.affaire affaire ON affaire.id=allocation.livraison_affaire_id
  JOIN public.clients customer ON customer.client_id=command.client_id
  LEFT JOIN public.articles article ON article.id=COALESCE(allocation.article_ref_id,line.article_id)
  LEFT JOIN public.piece_technique_versions technical ON technical.id=line.piece_technique_version_id
  LEFT JOIN public.delivery_promise_roots promise ON promise.allocation_id=allocation.id
  LEFT JOIN public.client_contract_calls call ON call.commande_id=command.id
  LEFT JOIN public.client_contract_legacy_orders legacy ON legacy.commande_id=command.id
  WHERE command.order_type<>'INTERNE'
    AND affaire.statut::text NOT IN ('ANNULE','ANNULEE','CANCELLED')
    AND allocation.qty_ordered>0
    AND COALESCE(allocation.article_ref_id,line.article_id) IS NOT NULL
    AND ($1::text='' OR command.numero ILIKE $2::text OR command.code_client ILIKE $2::text
      OR customer.company_name ILIKE $2::text OR customer.client_code ILIKE $2::text
      OR affaire.reference ILIKE $2::text OR article.code ILIKE $2::text OR line.designation ILIKE $2::text)
    AND ($3::text IS NULL OR command.client_id::text=$3::text)
    AND ($4::bigint IS NULL OR command.id=$4::bigint)
    AND ($5::bigint IS NULL OR affaire.id=$5::bigint)
), progress AS (
  SELECT source.*,
    COALESCE(reservations.reserved_qty,0)::float8 AS reserved_qty,
    COALESCE(reservations.available_qty,0)::float8 AS available_qty,
    COALESCE(reservations.preparable_reservation_ids,'[]'::jsonb) AS preparable_reservation_ids,
    COALESCE(shipments.shipped_qty,0)::float8 AS shipped_qty,
    COALESCE(shipments.prepared_qty,0)::float8 AS prepared_qty,
    greatest(source.qty_ordered-COALESCE(shipments.shipped_qty,0),0)::float8 AS remaining_qty,
    CASE WHEN COALESCE(shipments.shipped_qty,0)>=source.qty_ordered THEN 'COMPLETE'
      WHEN COALESCE(shipments.shipped_qty,0)>0 THEN 'PARTIAL' ELSE 'PENDING' END AS delivery_state
  FROM sources source
  LEFT JOIN LATERAL (
    SELECT sum(greatest(r.qty_reserved-r.qty_consumed,0)) AS reserved_qty,
      sum(greatest(r.qty_reserved-r.qty_consumed-r.qty_prepared,0)) AS available_qty,
      jsonb_agg(r.id::text ORDER BY r.created_at,r.id)
        FILTER(WHERE r.qty_reserved>r.qty_consumed+r.qty_prepared) AS preparable_reservation_ids
    FROM public.stock_reservations r WHERE r.commande_ligne_affaire_allocation_id=source.id
      AND r.livraison_affaire_id=source.livraison_affaire_id AND r.status='ACTIVE'
  ) reservations ON true
  LEFT JOIN LATERAL (
    SELECT sum(item.quantite) FILTER(WHERE bl.statut IN('SHIPPED','DELIVERED')) AS shipped_qty,
      sum(item.quantite) FILTER(WHERE bl.statut IN('DRAFT','READY')) AS prepared_qty
    FROM public.bon_livraison_ligne_allocations item
    JOIN public.bon_livraison_ligne line ON line.id=item.bon_livraison_ligne_id
    JOIN public.bon_livraison bl ON bl.id=line.bon_livraison_id
    WHERE item.commande_ligne_affaire_allocation_id=source.id
  ) shipments ON true
), filtered AS (SELECT * FROM progress WHERE $6::text='ALL' OR delivery_state=$6::text),
page AS (SELECT * FROM filtered ORDER BY ar_due_date NULLS LAST,requested_due_date NULLS LAST,commande_id,livraison_affaire_id,id
  LIMIT $7::int OFFSET $8::int)
SELECT COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY ar_due_date NULLS LAST,requested_due_date NULLS LAST,commande_id,livraison_affaire_id,id)
  FROM page),'[]'::jsonb) AS items,(SELECT count(*)::int FROM filtered) AS total,now()::text AS as_of
`;
type AffairRow = {
    id: number;
    commande_id: number;
    commande_ligne_id: number;
    livraison_affaire_id: number;
    qty_ordered: number;
    commande_numero: string;
    customer_order_reference: string | null;
    client_id: string;
    client_name: string;
    client_code: string | null;
    delivery_address_id: string | null;
    affaire_reference: string;
    delivery_readiness_state: string;
    article_id: string | null;
    article_code: string | null;
    designation: string | null;
    unit: string | null;
    article_indice: string | null;
    ar_due_date: string | null;
    requested_due_date: string | null;
    contract_id: string | null;
    contract_reference: string | null;
    reserved_qty: number;
    available_qty: number;
    shipped_qty: number;
    prepared_qty: number;
    remaining_qty: number;
    preparable_reservation_ids: string[];
    delivery_state: "PENDING" | "PARTIAL" | "COMPLETE";
    order_type: string;
};
export async function repoListDeliveryAffairs(query: DeliveryAffairsQuery) {
    const result = await pool.query<{
        items: AffairRow[];
        total: number;
        as_of: string;
    }>(DELIVERY_AFFAIRS_SQL, [query.q, `%${query.q}%`, query.client_id ?? null, query.commande_id ?? null, query.affaire_id ?? null,
        query.state, query.pageSize, (query.page - 1) * query.pageSize]);
    const row = result.rows[0];
    return { items: row.items.map(item => ({
            allocation_id: Number(item.id), commande_id: Number(item.commande_id), commande_ligne_id: Number(item.commande_ligne_id),
            livraison_affaire_id: Number(item.livraison_affaire_id), commande_numero: item.commande_numero,
            customer_order_reference: item.customer_order_reference, client_id: item.client_id, client_code: item.client_code,
            client_name: item.client_name, delivery_address_id: item.delivery_address_id, affaire_reference: item.affaire_reference,
            article_id: item.article_id, article_code: item.article_code, article_indice: item.article_indice, designation: item.designation,
            unit: item.unit, ar_due_date: item.ar_due_date, requested_due_date: item.requested_due_date,
            requested_qty: Number(item.qty_ordered), reserved_qty: Number(item.reserved_qty), available_qty: Number(item.available_qty),
            prepared_qty: Number(item.prepared_qty), shipped_qty: Number(item.shipped_qty), remaining_qty: Number(item.remaining_qty),
            delivery_state: item.delivery_state, delivery_readiness_state: item.delivery_readiness_state,
            contract_group_key: deliveryContractGroupKey({ commande_id: String(item.commande_id), client_id: item.client_id,
                contract_id: item.contract_id, order_type: item.order_type }), contract_reference: item.contract_reference,
            preparable_reservation_ids: item.preparable_reservation_ids,
            can_prepare: item.delivery_readiness_state === 'READY_FOR_BL' && item.remaining_qty > 0 && item.available_qty > 0,
        })), total: row.total, page: query.page, pageSize: query.pageSize, as_of: row.as_of,
        quantity_basis: 'SHIPPED_OR_DELIVERED_BL_ALLOCATIONS' as const, ar_basis: 'IMMUTABLE_SENT_AR' as const };
}
