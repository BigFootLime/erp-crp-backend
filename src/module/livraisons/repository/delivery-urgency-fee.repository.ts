import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { acceptedUrgencyFee } from '../domain/urgency-order-fee';

type Db = Pick<PoolClient, 'query'>;
export async function readDeliveryUrgencyFeeTx(tx: Db, allocationId: number, requestId?: string) {
  const row = (await tx.query<{ frozen_fee: unknown; amount_ht: string | null; currency: string | null;
    client_currency: string; tax_rate_percent: string | null; settings_version: number | null; charged: boolean }>(`
    SELECT COALESCE(accepted.snapshot->'preview'->'urgency_fee',
      CASE WHEN charge.id IS NOT NULL THEN jsonb_build_object('amount_ht',charge.amount_ht::text,
        'currency',charge.currency,'tax_rate_percent',charge.tax_rate_percent::text,'settings_version',charge.settings_version) END,
      pending.fee) AS frozen_fee,setting.amount_ht::text,setting.currency,
      COALESCE(NULLIF(upper(btrim(customer.devise)),''),'EUR') AS client_currency,
      line.taux_tva::text AS tax_rate_percent,setting.version AS settings_version,charge.id IS NOT NULL AS charged
    FROM public.commande_ligne_affaire_allocation allocation
    JOIN public.commande_client command ON command.id=allocation.commande_id
    JOIN public.commande_ligne line ON line.id=allocation.commande_ligne_id AND line.commande_id=command.id
    JOIN public.clients customer ON customer.client_id=command.client_id
    LEFT JOIN public.client_urgency_fee_settings setting ON setting.client_id=command.client_id
    LEFT JOIN public.delivery_urgency_order_charges charge ON charge.commande_id=command.id
    LEFT JOIN public.delivery_urgency_requests accepted ON accepted.id=$2::uuid AND accepted.beneficiary_allocation_id=allocation.id
    LEFT JOIN LATERAL (
      SELECT request.snapshot->'preview'->'urgency_fee' AS fee FROM public.delivery_urgency_requests request
      JOIN public.commande_ligne_affaire_allocation beneficiary ON beneficiary.id=request.beneficiary_allocation_id
      WHERE beneficiary.commande_id=command.id AND request.status IN('WAITING_PLANNER','APPROVED','WITHDRAWN')
        AND request.snapshot->'preview'->'urgency_fee' IS NOT NULL
      ORDER BY request.created_at,request.id LIMIT 1
    ) pending ON true WHERE allocation.id=$1`, [allocationId, requestId ?? null])).rows[0];
  if (!row) throw new HttpError(404, 'DELIVERY_ALLOCATION_NOT_FOUND', 'Affaire introuvable.');
  try {
    const frozen = row.frozen_fee;
    const fee = acceptedUrgencyFee(frozen
      ?? { amount_ht: row.amount_ht, currency: row.currency, tax_rate_percent: row.tax_rate_percent, settings_version: row.settings_version });
    if (!frozen && fee.currency !== row.client_currency)
      return { fee: null, charged: false, blocker: 'La devise du forfait doit correspondre à celle du client.' };
    return { fee, charged: row.charged, blocker: null };
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== 'URGENCY_FEE_REQUIRED') throw error;
    return { fee: null, charged: row.charged, blocker: error.message };
  }
}

/** Called in the withdrawal transaction; the unique order key survives subsequent partial deliveries. */
export async function recordDeliveryUrgencyFeeTx(tx: Db, args: { requestId: string; withdrawalId: string; actor: number }) {
  const request = (await tx.query<{ commande_id: string; client_id: string; fee: unknown }>(`
    SELECT allocation.commande_id::text,command.client_id,request.snapshot->'preview'->'urgency_fee' AS fee
    FROM public.delivery_urgency_requests request
    JOIN public.commande_ligne_affaire_allocation allocation ON allocation.id=request.beneficiary_allocation_id
    JOIN public.commande_client command ON command.id=allocation.commande_id
    WHERE request.id=$1::uuid`, [args.requestId])).rows[0];
  if (!request) throw new HttpError(404, 'URGENCY_REQUEST_NOT_FOUND', 'Demande introuvable.');
  const fee = acceptedUrgencyFee(request.fee);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`urgency-fee-order:${request.commande_id}`]);
  const existing = (await tx.query<{ id: string; amount_ht: string; currency: string; tax_rate_percent: string; settings_version: number }>(
    'SELECT id::text,amount_ht::text,currency,tax_rate_percent::text,settings_version FROM public.delivery_urgency_order_charges WHERE commande_id=$1 FOR UPDATE', [request.commande_id])).rows[0];
  if (existing) {
    if (JSON.stringify(acceptedUrgencyFee(existing)) !== JSON.stringify(fee))
      throw new HttpError(409, 'URGENCY_ORDER_FEE_CHANGED', 'Une autre urgence a déjà engagé un forfait différent sur cette commande. Actualisez la demande.');
    return { id: existing.id, already_applied: true };
  }
  const saved = (await tx.query<{ id: string }>(`INSERT INTO public.delivery_urgency_order_charges
    (commande_id,client_id,request_id,withdrawal_id,amount_ht,currency,tax_rate_percent,settings_version,created_by)
    VALUES($1,$2,$3::uuid,$4::uuid,$5,$6,$7,$8,$9) RETURNING id::text`,
    [request.commande_id,request.client_id,args.requestId,args.withdrawalId,fee.amount_ht,fee.currency,fee.tax_rate_percent,fee.settings_version,args.actor])).rows[0];
  if (!saved) throw new Error('Missing urgency order charge');
  return { id: saved.id, already_applied: false };
}
