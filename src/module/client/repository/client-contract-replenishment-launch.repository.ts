import type { PoolClient } from 'pg';
import type { ReplenishmentLaunchResult } from '../services/client-contract-replenishment-launch-tx';

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
