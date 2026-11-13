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
       SELECT COALESCE(o.numero, po.code) AS reference
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
     ORDER BY e.created_at,e.id LIMIT 1`,
      [proposal.article_id, proposal.kind, proposal.source_ids],
    )
  ).rows[0];
  return row?.reference;
}
