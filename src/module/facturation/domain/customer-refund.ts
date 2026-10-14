import { HttpError } from "../../../utils/httpError";
import { formatDecimal, moneyToCents } from "./decimal-money";

export const REFUND_ORIGIN_TYPES = ["INVOICE_ALLOCATION", "INVOICE_DIRECT", "APPLIED_ADVANCE"] as const;
export type RefundOrigin = {
  origin_type: typeof REFUND_ORIGIN_TYPES[number]; origin_id: string;
  payment_id: number; payment_allocation_id: string | null; payment_number: string;
  value_date: string; mode: string; source_available: string; allocation_available: string | null; payment_available: string;
};
export type RefundPlan = {
  amount: string;
  sources: Array<{ origin_type: RefundOrigin["origin_type"]; origin_id: string; payment_id: number;
    payment_allocation_id: string | null; payment_number: string; amount: string }>;
};

/** Select retained cash evidence automatically; share budgets across repeated origins. */
export function planCustomerRefund(args: {
  amount: string; invoiceRefundable: bigint; creditRemaining: bigint; origins: readonly RefundOrigin[];
}): RefundPlan {
  const requested = moneyToCents(args.amount);
  if (requested <= 0n || requested > args.invoiceRefundable || requested > args.creditRemaining) {
    throw new HttpError(409, "CUSTOMER_REFUND_AMOUNT_EXCEEDED", "Le remboursement dépasse le solde créditeur disponible de cet avoir.");
  }
  const payments = new Map<number,bigint>(), allocations = new Map<string,bigint>(), seen = new Set<string>();
  const ordered = [...args.origins].sort((a,b) => `${a.value_date}:${String(a.payment_id).padStart(16,"0")}:${a.origin_type}:${a.origin_id}`
    .localeCompare(`${b.value_date}:${String(b.payment_id).padStart(16,"0")}:${b.origin_type}:${b.origin_id}`));
  for (const origin of ordered) {
    const payment = moneyToCents(origin.payment_available), key = `${origin.origin_type}:${origin.origin_id}`;
    if (seen.has(key) || !Number.isSafeInteger(origin.payment_id) || origin.payment_id <= 0 || payment < 0n
      || moneyToCents(origin.source_available) < 0n || !/^\d{4}-\d{2}-\d{2}$/.test(origin.value_date)) {
      throw new HttpError(409, "CUSTOMER_REFUND_ORIGIN_INVALID", "Les paiements d’origine doivent être rapprochés avant remboursement.");
    }
    seen.add(key);
    if (payments.has(origin.payment_id) && payments.get(origin.payment_id) !== payment) throw new HttpError(409, "CUSTOMER_REFUND_ORIGIN_INVALID", "Budget de paiement incohérent.");
    payments.set(origin.payment_id,payment);
    if (origin.payment_allocation_id) {
      const available = moneyToCents(origin.allocation_available ?? "0");
      if (available < 0n || (allocations.has(origin.payment_allocation_id) && allocations.get(origin.payment_allocation_id) !== available))
        throw new HttpError(409, "CUSTOMER_REFUND_ORIGIN_INVALID", "Budget d’affectation incohérent.");
      allocations.set(origin.payment_allocation_id,available);
    }
  }
  let remaining = requested;
  const sources: RefundPlan["sources"] = [];
  for (const origin of ordered) {
    if (remaining === 0n) break;
    const limits = [remaining,moneyToCents(origin.source_available),payments.get(origin.payment_id)!];
    if (origin.payment_allocation_id) limits.push(allocations.get(origin.payment_allocation_id)!);
    const amount = limits.reduce((minimum,value) => value < minimum ? value : minimum);
    if (amount === 0n) continue;
    payments.set(origin.payment_id,payments.get(origin.payment_id)!-amount);
    if (origin.payment_allocation_id) allocations.set(origin.payment_allocation_id,allocations.get(origin.payment_allocation_id)!-amount);
    remaining -= amount;
    sources.push({origin_type:origin.origin_type,origin_id:origin.origin_id,payment_id:origin.payment_id,
      payment_allocation_id:origin.payment_allocation_id,payment_number:origin.payment_number,amount:formatDecimal(amount,2)});
  }
  if (remaining !== 0n) throw new HttpError(409, "CUSTOMER_REFUND_CASH_MISSING", "Les paiements d'origine ne couvrent pas le remboursement demandé.");
  return {amount:formatDecimal(requested,2),sources};
}
