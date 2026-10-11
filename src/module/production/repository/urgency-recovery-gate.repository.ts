import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';

/** The planner may prepare a recovery, but pending requests cannot enter execution. */
export async function assertUrgencyRecoveryStartTx(tx: Pick<PoolClient, 'query'>, ofId: number) {
  const pending = (await tx.query<{id:string;status:string}>(`SELECT request.id::text,request.status
    FROM public.ordres_fabrication producer JOIN public.delivery_urgency_recoveries recovery
      ON recovery.recovery_of_id=COALESCE(producer.root_of_id,producer.id)
    JOIN public.delivery_urgency_requests request ON request.id=recovery.request_id
    WHERE producer.id=$1 AND request.status IN('WAITING_PLANNER','CANCELLED')`,[ofId])).rows[0];
  if (pending) throw new HttpError(409,'URGENCY_RECOVERY_NOT_APPROVED',
    pending.status==='CANCELLED' ? 'Cette demande urgente a été annulée.' : 'Le planificateur doit valider la récupération avant le démarrage.',
    {request_id:pending.id});
}
