import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { readUrgencyRecoveryScopesTx } from './urgency-recovery-scope.repository';

/** The planner may prepare a recovery, but pending requests cannot enter execution. */
export async function assertUrgencyRecoveryStartTx(tx: Pick<PoolClient, 'query'>, ofId: number) {
  const pending = (await readUrgencyRecoveryScopesTx(tx, [ofId], ['WAITING_PLANNER', 'CANCELLED']))
    .find(scope => scope.status !== 'CANCELLED' || scope.cancellation_retains_production !== true);
  if (pending) throw new HttpError(409,'URGENCY_RECOVERY_NOT_APPROVED',
    pending.status==='CANCELLED' ? 'Cette demande urgente a été annulée.' : 'Le planificateur doit valider la récupération avant le démarrage.',
    {request_id:pending.request_id, recovery_of_id:pending.recovery_of_id});
}
