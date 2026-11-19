import pool from "../../../config/database";
import type { ClientPortalIdentity } from "../types/client-portal.types";
import type { PortalPieceTrackingQuery } from "../validators/client-portal.validators";

export async function repoTrackPortalPieces(identity: ClientPortalIdentity, query: PortalPieceTrackingQuery) {
  const { page, pageSize, q } = query;
  const result = await pool.query(
    `WITH scoped AS MATERIALIZED (
       SELECT line.id, cc.id AS order_id, cc.numero AS order_number,
              NULLIF(btrim(cc.code_client), '') AS customer_order,
              line.ordre AS line_number, line.code_piece AS part_number,
              line.designation, line.unite AS unit, line.quantite AS ordered,
              line.delai_client::text AS requested_date, cc.destinataire_id,
              published.statut AS order_status,
              GREATEST(cc.updated_at, line.updated_at) AS updated_at
         FROM public.client_portal_orders_v published
         JOIN public.commande_client cc ON cc.id=published.id::bigint AND cc.client_id=published.client_id
         JOIN public.client_portal_delivery_site_bindings binding
           ON binding.account_id=$1::uuid AND binding.delivery_address_id=cc.destinataire_id
         JOIN public.commande_ligne line ON line.commande_id=cc.id
        WHERE published.client_id=$2 AND cc.order_type='FERME'
          AND ($3='' OR strpos(lower(line.code_piece),lower($3))>0
                OR strpos(lower(line.designation),lower($3))>0
                OR strpos(lower(cc.numero),lower($3))>0
                OR strpos(lower(cc.code_client),lower($3))>0)
     ), current_page AS (
       SELECT * FROM scoped ORDER BY updated_at DESC, id DESC LIMIT $4 OFFSET $5
     ), tracking AS (
       SELECT line.id::text, line.updated_at, line.order_number, line.customer_order, line.line_number,
              line.part_number, line.designation, line.unit,
              line.ordered::text AS ordered_quantity,
              sent.quantity::text AS shipped_quantity,
              GREATEST(line.ordered-sent.quantity,0)::text AS remaining_quantity,
              line.requested_date, COALESCE(ar.parts,'[]'::jsonb) AS commitments,
              CASE WHEN line.order_status IN ('ANNULE','ANNULEE') THEN 'CANCELLED'
                   WHEN sent.quantity>=line.ordered THEN 'SHIPPED'
                   WHEN sent.quantity>0 THEN 'PARTIAL'
                   WHEN factory.running THEN 'IN_PRODUCTION'
                   WHEN factory.paused THEN 'PAUSED'
                   WHEN factory.planned THEN 'PLANNED'
                   WHEN factory.finished_quantity>=line.ordered-sent.quantity THEN 'PRODUCTION_FINISHED'
                   ELSE 'ORDERED' END AS stage,
              CASE WHEN line.order_status NOT IN ('ANNULE','ANNULEE')
                        AND sent.quantity<line.ordered
                        AND factory.covered_quantity>=line.ordered-sent.quantity
                   THEN factory.end_on::text END AS estimated_workshop_date
         FROM current_page line
         CROSS JOIN LATERAL (
           SELECT COALESCE(sum(delivered.quantity),0) AS quantity
             FROM (
               SELECT item.quantite AS quantity, item.bon_livraison_ligne_id
                 FROM public.commande_ligne_affaire_allocation allocation
                 JOIN public.bon_livraison_ligne_allocations item
                   ON item.commande_ligne_affaire_allocation_id=allocation.id
                WHERE allocation.commande_ligne_id=line.id AND allocation.commande_id=line.order_id
               UNION ALL
               SELECT bl_line.quantite, bl_line.id
                 FROM public.bon_livraison_ligne bl_line
                WHERE bl_line.commande_ligne_id=line.id
                  AND NOT EXISTS (SELECT 1 FROM public.bon_livraison_ligne_allocations item
                    WHERE item.bon_livraison_ligne_id=bl_line.id AND item.commande_ligne_affaire_allocation_id IS NOT NULL)
             ) delivered
             JOIN public.bon_livraison_ligne bl_line ON bl_line.id=delivered.bon_livraison_ligne_id
             JOIN public.bon_livraison bl ON bl.id=bl_line.bon_livraison_id
            WHERE bl.client_id=$2 AND bl.adresse_livraison_id=line.destinataire_id
              AND bl.statut IN ('SHIPPED','DELIVERED')
         ) sent
         CROSS JOIN LATERAL (
           SELECT bool_or(ofa.statut::text='EN_COURS') AS running,
                  bool_or(ofa.statut::text='EN_PAUSE') AS paused,
                  bool_or(ofa.statut::text='PLANIFIE') AS planned,
                  sum(ofa.quantite_bonne) FILTER (WHERE ofa.statut::text IN ('TERMINE','CLOTURE')) AS finished_quantity,
                  sum(ofa.quantite_lancee) FILTER (
                    WHERE ofa.statut::text IN ('PLANIFIE','EN_COURS')
                      AND ofa.date_fin_prevue>=CURRENT_DATE) AS covered_quantity,
                  max(ofa.date_fin_prevue) FILTER (
                    WHERE ofa.statut::text IN ('PLANIFIE','EN_COURS')
                      AND ofa.date_fin_prevue>=CURRENT_DATE) AS end_on
             FROM public.ordres_fabrication ofa
            WHERE ofa.commande_id=line.order_id AND ofa.commande_ligne_id=line.id
              AND ofa.client_id=$2 AND ofa.parent_of_id IS NULL
              AND ofa.statut::text<>'ANNULE'
              AND NOT EXISTS (
                SELECT 1 FROM public.production_consolidation_allocations consolidated
                 WHERE consolidated.source_of_id=ofa.id AND consolidated.state='ACTIVE')
         ) factory
         CROSS JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object('date',part.due_date::text,
                      'quantity',(part.quantity-shipped.quantity)::text) ORDER BY part.due_date,part.id) AS parts
             FROM public.delivery_promise_roots root
             JOIN public.delivery_promise_site_evidence evidence
               ON evidence.root_id=root.id AND evidence.delivery_address_id=line.destinataire_id
             JOIN public.delivery_promise_parts part ON part.root_id=root.id AND part.retired_at IS NULL
             CROSS JOIN LATERAL (
               SELECT COALESCE(sum(shipment.quantity),0) AS quantity
                 FROM public.delivery_promise_shipments shipment WHERE shipment.part_id=part.id
             ) shipped
            WHERE root.line_id=line.id AND root.commande_id=line.order_id AND part.quantity>shipped.quantity
         ) ar
     )
     SELECT COALESCE((SELECT jsonb_agg(to_jsonb(tracking)-'updated_at' ORDER BY updated_at DESC,id::bigint DESC) FROM tracking),'[]'::jsonb) AS items,
            (SELECT count(*)::int FROM scoped) AS total, now()::text AS read_at`,
    [identity.accountId, identity.clientId, q, pageSize, (page-1)*pageSize],
  );
  const { items, total, read_at } = result.rows[0];
  return {
    data: items,
    pagination: { page, pageSize, total },
    meta: { source: "CERP", freshness_at: read_at, reliability: "SYSTEM_OF_RECORD" },
  };
}
