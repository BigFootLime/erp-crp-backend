import crypto from "node:crypto";
import type { PoolClient } from "pg";
import type { ProformaPreview, ProformaPreviewAffair } from "../types/proforma.types";

async function persistBillingShares(tx: PoolClient, affair: ProformaPreviewAffair, actorId: number, correlationId: string): Promise<Map<string, string>> {
  const current = (await tx.query<{ id: string; billed_client_id: string; quantity: string; plan_version: number }>(
    "SELECT id::text,billed_client_id,quantity::numeric(18,3)::text,plan_version FROM public.delivery_affair_billing_shares WHERE allocation_id=$1 AND active ORDER BY billed_client_id FOR UPDATE", [affair.allocation_id])).rows;
  const same = current.length === affair.billing_parts.length && affair.billing_parts.every(part =>
    current.some(share => share.billed_client_id === part.billed_client_id && share.quantity === part.quantity));
  if (same) return new Map(current.map(share => [share.billed_client_id, share.id]));
  await tx.query("UPDATE public.delivery_affair_billing_shares SET active=false,row_version=row_version+1 WHERE allocation_id=$1 AND active", [affair.allocation_id]);
  const version = (await tx.query<{ version: number }>("SELECT COALESCE(max(plan_version),0)+1 AS version FROM public.delivery_affair_billing_shares WHERE allocation_id=$1", [affair.allocation_id])).rows[0]!.version;
  const ids = new Map<string, string>();
  for (const part of affair.billing_parts) {
    const id = crypto.randomUUID();
    await tx.query(`INSERT INTO public.delivery_affair_billing_shares(id,allocation_id,billed_client_id,quantity,plan_version,created_by,correlation_id)
      VALUES($1::uuid,$2,$3,$4::numeric,$5,$6,$7::uuid)`, [id, affair.allocation_id, part.billed_client_id, part.quantity, version, actorId, correlationId]);
    ids.set(part.billed_client_id, id);
  }
  return ids;
}

/** Caller holds the draft header and shared commercial locks. Existing draft
 * parts must be removed before replacement; issued parts are never rewritten. */
export async function persistProformaDraftContentTx(tx: PoolClient, args: {
  id: string; reference: string; preview: ProformaPreview; actorId: number; correlationId: string;
}): Promise<void> {
  for (const affair of args.preview.affairs) {
    const shares = await persistBillingShares(tx, affair, args.actorId, args.correlationId);
    const line = (await tx.query<{ id: string }>(`INSERT INTO public.proforma_affair_lines(id,proforma_id,allocation_id,quantity,source_revision,source_snapshot)
      VALUES($1::uuid,$2::uuid,$3,$4::numeric,$5,$6::jsonb)
      ON CONFLICT(proforma_id,allocation_id) DO UPDATE SET quantity=EXCLUDED.quantity,
        source_revision=EXCLUDED.source_revision,source_snapshot=EXCLUDED.source_snapshot RETURNING id::text`,
      [crypto.randomUUID(), args.id, affair.allocation_id, affair.source_snapshot.quantity, affair.source_revision, JSON.stringify(affair.source_snapshot)])).rows[0]!;
    for (const part of affair.billing_parts) await tx.query(`INSERT INTO public.proforma_billing_parts
      (proforma_line_id,billing_share_id,billed_client_id,quantity,unit_price_ex_tax,discount_percent,global_discount_percent,tax_rate_percent,total_ex_tax,tax_amount,total_incl_tax,billed_client_snapshot)
      VALUES($1::uuid,$2::uuid,$3,$4::numeric,$5::numeric,$6::numeric,$7::numeric,$8::numeric,$9::numeric,$10::numeric,$11::numeric,$12::jsonb)`,
      [line.id, shares.get(part.billed_client_id), part.billed_client_id, part.quantity, part.unit_price_ex_tax, part.discount_percent, part.global_discount_percent,
        part.tax_rate_percent, part.total_ex_tax, part.tax_amount, part.total_incl_tax, JSON.stringify(part.billed_client_snapshot)]);
    await tx.query(`INSERT INTO public.delivery_affair_prepayment_terms(allocation_id,requirement,proforma_line_id,decision_reason,updated_by,correlation_id)
      VALUES($1,'PROFORMA',$2::uuid,$3,$4,$5::uuid) ON CONFLICT(allocation_id) DO UPDATE SET requirement='PROFORMA',proforma_line_id=EXCLUDED.proforma_line_id,
        row_version=delivery_affair_prepayment_terms.row_version+1,decision_reason=EXCLUDED.decision_reason,updated_at=now(),updated_by=EXCLUDED.updated_by,correlation_id=EXCLUDED.correlation_id`,
      [affair.allocation_id, line.id, `Préparation ${args.reference}`, args.actorId, args.correlationId]);
  }
}
