import { HttpError } from "../../../utils/httpError";
import { formatDecimal, moneyToCents, parseDecimal } from "./decimal-money";

export type AdvanceClearingSnapshot = {
  version: 1;
  amount_incl_tax: string;
  entries: Array<{
    deposit_invoice_id: number; deposit_invoice_sha256: string;
    payment_allocation_id: string; deposit_source_id: string;
    tax_rate: string; amount_ex_tax: string; tax_amount: string; amount_incl_tax: string;
  }>;
};

export function readAdvanceClearing(snapshot: unknown, expectedPaid: string): AdvanceClearingSnapshot {
  const invalid = (): never => { throw new HttpError(409, "ADVANCE_CLEARING_EVIDENCE_INVALID", "La reprise des acomptes doit être rapprochée des factures et paiements d'origine."); };
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) invalid();
  const value = snapshot as AdvanceClearingSnapshot;
  if (value.version !== 1 || !Array.isArray(value.entries) || !value.entries.length) invalid();
  let gross = 0n;
  const keys = new Set<string>();
  for (const entry of value.entries) {
    if (!entry || typeof entry !== "object" || !Number.isSafeInteger(entry.deposit_invoice_id) || entry.deposit_invoice_id <= 0
      || !/^[a-f0-9]{64}$/.test(entry.deposit_invoice_sha256) || !/^[a-f0-9-]{36}$/.test(entry.payment_allocation_id)
      || !/^[a-f0-9-]{36}$/.test(entry.deposit_source_id)) invalid();
    const net = moneyToCents(entry.amount_ex_tax), tax = moneyToCents(entry.tax_amount), amount = moneyToCents(entry.amount_incl_tax),
      rate = parseDecimal(entry.tax_rate, 4, "Taux de TVA");
    const key = `${entry.payment_allocation_id}:${entry.deposit_source_id}:${formatDecimal(rate,4)}`;
    if (keys.has(key)) invalid(); keys.add(key);
    if (net < 0n || tax < 0n || amount <= 0n || net + tax !== amount || rate < 0n || rate > 1_000_000n || (rate === 0n && tax !== 0n)) invalid();
    gross += amount;
  }
  if (gross !== moneyToCents(value.amount_incl_tax) || gross !== moneyToCents(expectedPaid)) invalid();
  return { ...value, amount_incl_tax: formatDecimal(gross, 2) };
}
