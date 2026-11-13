import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';

/** Read original anticipated targets through root/child and active producer ownership.
 * A firm order takes back commercial ownership. Fulfilled group shares cannot
 * keep imposing an old target on the remaining producer. No slot/date is written. */
export const REPLENISHMENT_PLANNING_TARGETS_SQL = `WITH requested AS (
  SELECT id,COALESCE(root_of_id,id) AS root_id FROM public.ordres_fabrication WHERE id=ANY($1::bigint[])
), owners AS (
  SELECT id AS requested_id,root_id FROM requested
  UNION
  SELECT requested.id,COALESCE(source.root_of_id,source.id)
  FROM requested JOIN public.production_consolidations consolidation ON consolidation.producer_of_id=requested.root_id AND consolidation.state='ACTIVE'
  JOIN public.production_consolidation_allocations share ON share.consolidation_id=consolidation.id
    AND share.state='ACTIVE' AND share.quantity>share.received_quantity
  JOIN public.ordres_fabrication source ON source.id=share.source_of_id
) SELECT owners.requested_id::text AS of_id,min(evidence.target_date)::text AS target_date
  FROM owners JOIN public.client_contract_replenishment_roots evidence ON evidence.root_of_id=owners.root_id
  JOIN public.ordres_fabrication source ON source.id=owners.root_id
  WHERE source.commande_ligne_id IS NULL AND source.statut::text<>'ANNULE'
  GROUP BY owners.requested_id ORDER BY owners.requested_id`;

export async function readReplenishmentPlanningTargets(tx: Pick<PoolClient,'query'>, ids: readonly number[]) {
  if(ids.some(id=>!Number.isSafeInteger(id)||id<=0)||ids.length>10000)
    throw new HttpError(422,'CONTRACT_REPLENISHMENT_TARGET_SCOPE_INVALID','Le périmètre des OF à lire est invalide.');
  const distinct=[...new Set(ids)];
  if(!distinct.length)return new Map<number,string>();
  const installed=(await tx.query<{installed:boolean}>(`SELECT to_regclass('public.client_contract_replenishment_roots') IS NOT NULL AS installed`)).rows[0];
  // Existing planning continues to work before the additive contract migration.
  if(!installed?.installed)return new Map<number,string>();
  const rows=(await tx.query<{of_id:string;target_date:string}>(REPLENISHMENT_PLANNING_TARGETS_SQL,[distinct])).rows;
  return new Map(rows.map(row=>[Number(row.of_id),row.target_date]));
}

/** A forecast finish is never supplied as commercialDue by either caller. */
export function earliestReplenishmentTarget(commercialDue: string|null|undefined, target: string) {
  return commercialDue && commercialDue<target ? commercialDue : target;
}
