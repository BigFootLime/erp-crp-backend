import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { computeExactLineTotals } from '../domain/decimal-money';
import type { FacturePreviewLine } from '../types/workflow.types';

type Db = Pick<PoolClient, 'query'>;
export async function readInvoiceUrgencyChargesTx(tx: Db, args: {
  orderIds: string[]; clientId: string; currency: string; lock: boolean; invoiceId?: number;
}): Promise<FacturePreviewLine[]> {
  const orders = [...new Set(args.orderIds)].sort();
  if (!orders.length) return [];
  // Two statements are intentional: after waiting for the row lock, the fresh
  // read sees the invoice binding committed by the competing transaction.
  if (args.lock) await tx.query(`SELECT id FROM public.delivery_urgency_order_charges
    WHERE commande_id=ANY($1::bigint[]) ORDER BY commande_id FOR UPDATE`, [orders]);
  const rows = (await tx.query<{ id: string; commande_id: string; numero: string; client_id: string;
    amount_ht: string; currency: string; tax_rate_percent: string; settings_version: number }>(`
    SELECT charge.id::text,charge.commande_id::text,command.numero,charge.client_id,
      charge.amount_ht::text,charge.currency,charge.tax_rate_percent::text,charge.settings_version
    FROM public.delivery_urgency_order_charges charge JOIN public.commande_client command ON command.id=charge.commande_id
    LEFT JOIN public.facture_urgency_charges binding ON binding.charge_id=charge.id
    WHERE charge.commande_id=ANY($1::bigint[])
      AND (($2::bigint IS NULL AND binding.charge_id IS NULL) OR binding.facture_id=$2::bigint)
    ORDER BY charge.commande_id,charge.id`, [orders,args.invoiceId ?? null])).rows;
  return rows.map(row => {
    if (row.client_id !== args.clientId || row.currency !== args.currency)
      throw new HttpError(409, 'URGENCY_INVOICE_SCOPE_MISMATCH', 'La facture doit conserver le client et la devise du forfait urgence accepté.');
    const totals = computeExactLineTotals({ quantity:'1.000', unitPriceExTax:row.amount_ht,discountPercent:'0.0000',taxRatePercent:row.tax_rate_percent });
    return { source_type:'ORDER_CHARGE',source_id:row.commande_id,source_line_id:row.id,
      designation:`Forfait urgence · ${row.numero}`,code_piece:null,unit:'forfait',quantity:'1.000',
      unit_price_ex_tax:row.amount_ht,discount_percent:'0.0000',tax_rate_percent:row.tax_rate_percent,
      total_ex_tax:totals.totalExTax,tax_amount:totals.taxAmount,total_incl_tax:totals.totalInclTax,
      pricing_version:`URGENCY:${row.id}:${row.settings_version}`,rule_code:'URGENCY_ONCE_PER_ORDER' };
  });
}

export async function bindInvoiceUrgencyChargeTx(tx: Db, args: { chargeId:string; invoiceId:number; lineId:string; actor:number }) {
  await tx.query(`INSERT INTO public.facture_urgency_charges(charge_id,facture_id,facture_ligne_id,created_by)
    VALUES($1::uuid,$2,$3,$4)`, [args.chargeId,args.invoiceId,args.lineId,args.actor]);
}
