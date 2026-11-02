import type { PoolClient } from "pg";
import type { IndustrialProposal } from "../types/industrial-plan.types";

/** An open order can already cover the need without being reliable enough
 * for ATP, e.g. an unconfirmed purchase or an OF still in preparation. */
export async function findOpenIndustrialOrder(
  tx: PoolClient,
  proposal: IndustrialProposal,
) {
  const row = (
    await tx.query<{ reference: string }>(
      `WITH firm AS (
         SELECT split_part(origin, ':', 2) AS line, split_part(origin, ':', 3) AS allocation
         FROM unnest($3::text[]) origin WHERE origin LIKE 'firm:%'
       ), pegging AS (
         SELECT unnest($3::text[]) AS id
         UNION SELECT concat('firm:',line,'::default') FROM firm
         UNION SELECT concat('firm:',line,':',allocation,':default') FROM firm
         UNION SELECT concat('firm:',f.line,':',f.allocation,':',p.id)
         FROM firm f JOIN public.delivery_promise_roots root ON root.allocation_id::text=f.allocation
         JOIN public.delivery_promise_parts p ON p.root_id=root.id AND p.retired_at IS NOT NULL
       )
       SELECT reference FROM (
       SELECT COALESCE(o.numero, po.code) AS reference, e.created_at, e.id::text AS stable_id
     FROM public.industrial_proposal_executions e
     JOIN public.industrial_plan_runs r ON r.id=e.run_id
     CROSS JOIN LATERAL (SELECT r.result->'proposals'->e.proposal_index AS p) prior
     LEFT JOIN public.ordres_fabrication o ON e.target_type='OF' AND o.id::text=e.target_id
       AND o.statut::text NOT IN ('ANNULE','TERMINE','CLOTURE')
     LEFT JOIN public.commande_fournisseur po ON e.target_type='COMMANDE_FOURNISSEUR' AND po.id::text=e.target_id
       AND po.statut NOT IN ('RECUE','ANNULEE','CLOTUREE')
       AND EXISTS (SELECT 1 FROM public.commande_fournisseur_ligne l
         WHERE l.commande_id=po.id AND l.article_id=$1::uuid AND l.statut_ligne='ACTIVE' AND l.quantite>l.qty_annulee)
     WHERE e.status='EXECUTED' AND e.action=$2
       AND prior.p->>'article_id'=$1::text AND (prior.p->'source_ids') ?| ARRAY(SELECT id FROM pegging)
       AND (o.id IS NOT NULL OR po.id IS NOT NULL)
       UNION ALL
       /* Orders entered outside industrial_plan_runs have no JSON pegging.
        * A matching firm line/contract is enough to stop automatic duplicate
        * creation; an unrelated order is intentionally left out here. */
       SELECT o.numero AS reference, o.created_at, o.id::text AS stable_id
       FROM public.ordres_fabrication o
       WHERE o.article_id=$1::uuid AND o.parent_of_id IS NULL
         AND o.statut::text NOT IN ('ANNULE','TERMINE','CLOTURE')
         AND (
           o.commande_ligne_id::text IN (SELECT line FROM firm)
           OR ($4::text IS NOT NULL AND EXISTS(
             SELECT 1 FROM public.client_contract_replenishment_roots root
             JOIN public.client_contract_replenishment_proposals prep ON prep.id=root.proposal_id
             WHERE root.root_of_id=o.id AND prep.contract_line_id::text=$4::text
           ))
         )
       UNION ALL
       /* Supplier orders do not always retain the client peg.  In the pilot,
        * an open line for the same article must be reviewed before another OA
        * is created rather than silently double-covering a shortage. */
       SELECT po.code AS reference, po.created_at, po.id::text AS stable_id
       FROM public.commande_fournisseur po
       JOIN public.commande_fournisseur_ligne line ON line.commande_id=po.id
       WHERE line.article_id=$1::uuid AND line.statut_ligne='ACTIVE'
         AND line.quantite>line.qty_annulee
         AND po.statut NOT IN ('RECUE','ANNULEE','CLOTUREE')
       ) candidates
     ORDER BY created_at,stable_id LIMIT 1`,
      [
        proposal.article_id,
        proposal.kind,
        proposal.source_ids,
        proposal.contract_line_id,
      ],
    )
  ).rows[0];
  return row?.reference;
}
