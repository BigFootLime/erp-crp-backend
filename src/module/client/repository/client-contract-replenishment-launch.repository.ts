import type { PoolClient } from 'pg';
import type { ReplenishmentLaunchResult } from '../services/client-contract-replenishment-launch-tx';
import type { ReplenishmentPlanLaunchLink } from '../types/client-contract-replenishment.types';

export type ReplenishmentLaunchReplay = {
  client_id: string; contract_id: string; request_hash: string;
  result_payload: ReplenishmentLaunchResult;
};

/** Immutable acknowledgement shared by the transaction and commit reconciliation. */
export async function readReplenishmentLaunchReplay(tx: Pick<PoolClient, 'query'>, actor: number, key: string) {
  return (await tx.query<ReplenishmentLaunchReplay>(
    `SELECT contract.client_id::text,launch.contract_id::text,launch.request_hash,launch.result_payload
     FROM public.client_contract_replenishment_launches launch JOIN public.client_contracts contract ON contract.id=launch.contract_id
     WHERE launch.actor_user_id=$1 AND launch.idempotency_key=$2::uuid`, [actor, key])).rows[0] ?? null;
}

/** Persisted proposal evidence is the authority when a preparation is reopened,
 * including cancelled OFs: that proposal cannot silently be launched again. */
export async function readReplenishmentPlanLaunches(tx: Pick<PoolClient, 'query'>, contractId: string, planId: string): Promise<ReplenishmentPlanLaunchLink[]> {
  const result = await tx.query<Omit<ReplenishmentPlanLaunchLink, 'root_of_id'> & { root_of_id: string }>(
    `SELECT root.proposal_id::text,root.root_of_id::text,of.numero AS number,of.statut AS status,
       root.quantity::text,root.target_date::text,root.lot_index
     FROM public.client_contract_replenishment_roots root JOIN public.ordres_fabrication of ON of.id=root.root_of_id
     WHERE root.contract_id=$1::uuid AND root.plan_id=$2::uuid ORDER BY root.target_date,root.root_of_id`, [contractId, planId]);
  return result.rows.map(row => {
    const id = Number(row.root_of_id);
    if (!Number.isSafeInteger(id) || id < 1) throw Error('CONTRACT_REPLENISHMENT_ROOT_ID_INVALID');
    return { ...row, root_of_id: id };
  });
}
