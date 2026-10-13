import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { withRealtimeOutboxTransaction } from '../../../shared/realtime/realtime-outbox-transaction';
import { enqueueEntityChanged } from '../../../shared/realtime/realtime-outbox.service';
import { repoInsertAuditLog } from '../../audit-logs/repository/audit-logs.repository';
import type { AuditContext } from './client.repository';
import type { ClientUrgencyFeeBody } from '../validators/client-urgency-fee.validators';

export async function readClientUrgencyFeeTx(tx: Pick<PoolClient, 'query'>, clientId: string) {
  const row = (await tx.query<{ client_id: string; client_active: boolean; client_currency: string;
    amount_ht: string | null; currency: string | null; version: number; updated_at: string | null }>(`
    SELECT c.client_id,NOT(COALESCE(c.blocked,false) OR lower(c.status)='inactif') AS client_active,
      COALESCE(NULLIF(upper(btrim(c.devise)),''),'EUR') AS client_currency,
      s.amount_ht::text,s.currency,COALESCE(s.version,0)::int AS version,s.updated_at::text
    FROM public.clients c LEFT JOIN public.client_urgency_fee_settings s ON s.client_id=c.client_id
    WHERE c.client_id=$1`, [clientId])).rows[0];
  if (!row) throw new HttpError(404, 'CLIENT_NOT_FOUND', 'Client introuvable.');
  return row;
}
export const repoReadClientUrgencyFee = (clientId: string) => readClientUrgencyFeeTx(pool, clientId);
export async function repoSaveClientUrgencyFee(clientId: string, body: ClientUrgencyFeeBody, audit: AuditContext) {
  return withRealtimeOutboxTransaction(await pool.connect(), async tx => {
    await tx.query('SELECT client_id FROM public.clients WHERE client_id=$1 FOR UPDATE', [clientId]);
    const before = await readClientUrgencyFeeTx(tx, clientId);
    if (!before.client_active) throw new HttpError(409, 'CLIENT_INACTIVE', 'Réactivez la fiche client avant de modifier son forfait.');
    if (before.version !== body.expected_version) throw new HttpError(409, 'URGENCY_FEE_CHANGED', 'Le forfait a changé. Actualisez la fiche.');
    if (body.currency !== before.client_currency) throw new HttpError(409, 'URGENCY_FEE_CURRENCY_CHANGED', 'La devise du client a changé. Actualisez la fiche.');
    await tx.query(`INSERT INTO public.client_urgency_fee_settings(client_id,amount_ht,currency,updated_by)
      VALUES($1,$2,$3,$4) ON CONFLICT(client_id) DO UPDATE SET amount_ht=excluded.amount_ht,currency=excluded.currency,
        version=client_urgency_fee_settings.version+1,updated_by=excluded.updated_by,updated_at=now()`,
      [clientId, body.amount_ht, body.currency, audit.user_id]);
    const result = await readClientUrgencyFeeTx(tx, clientId);
    await repoInsertAuditLog({ ...audit, tx, body: { event_type: 'ACTION', action: 'CLIENT_URGENCY_FEE_UPDATED',
      entity_type: 'client', entity_id: clientId, page_key: audit.page_key, path: audit.path,
      client_session_id: audit.client_session_id, details: { before, after: result } } });
    await enqueueEntityChanged(tx, { entityType: 'CLIENT', entityId: clientId, module: 'clients', action: 'updated',
      at: new Date().toISOString(), invalidateKeys: ['clients:list',`clients:detail:${clientId}`] },
      {deduplicationKey:`client-urgency-fee:${clientId}:${result.version}`});
    return result;
  });
}
