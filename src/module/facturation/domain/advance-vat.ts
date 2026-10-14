import { HttpError } from "../../../utils/httpError";
import { divideHalfUp, formatDecimal, moneyToCents, parseDecimal } from "./decimal-money";
import { apportionExactCents } from "./final-prepayment-targets";

export type AdvanceVatSnapshot = {
  version: 1;
  invoice_id: number;
  invoice_sha256: string;
  allocation_amount: string;
  cash_before: string;
  cash_after: string;
  tax_before: string;
  tax_after: string;
  entries: Array<{ tax_rate: string; tax_amount: string }>;
};

function invalid(): never {
  throw new HttpError(409, "ADVANCE_VAT_EVIDENCE_INVALID", "La TVA de cet acompte doit être rapprochée de ses encaissements avant cette opération.");
}

/** Freeze only the new cash effect. Previously booked cents never move between rates. */
export function planAdvanceVat(args: {
  invoiceId: number;
  invoiceSha256: string;
  invoiceGross: string;
  allocationAmount: string;
  originalTax: ReadonlyArray<{ tax_rate: string; tax_amount: string }>;
  prior: readonly AdvanceVatSnapshot[];
}): AdvanceVatSnapshot {
  const gross = moneyToCents(args.invoiceGross), amount = moneyToCents(args.allocationAmount);
  if (!Number.isSafeInteger(args.invoiceId) || args.invoiceId <= 0 || !/^[a-f0-9]{64}$/.test(args.invoiceSha256)
    || gross <= 0n || amount <= 0n) invalid();
  const original = new Map<string, bigint>();
  const normalizeRate = (rate: string): string => {
    const parsed = parseDecimal(rate, 4, "Taux de TVA");
    if (parsed < 0n || parsed > 1_000_000n) invalid();
    return formatDecimal(parsed, 4);
  };
  for (const entry of args.originalTax) {
    const rate = normalizeRate(entry.tax_rate), tax = moneyToCents(entry.tax_amount);
    if (original.has(rate) || tax < 0n || (parseDecimal(rate, 4, "Taux de TVA") === 0n && tax !== 0n)) invalid();
    original.set(rate, tax);
  }
  const totalTax = [...original.values()].reduce((sum, tax) => sum + tax, 0n);
  if (!original.size || totalTax >= gross) invalid();
  const recognized = new Map<string, bigint>();
  let cashBefore = 0n, taxBefore = 0n;
  for (const snapshot of args.prior) {
    if (!snapshot || snapshot.version !== 1 || snapshot.invoice_id !== args.invoiceId
      || snapshot.invoice_sha256 !== args.invoiceSha256 || !Array.isArray(snapshot.entries)) invalid();
    const priorAmount = moneyToCents(snapshot.allocation_amount), before = moneyToCents(snapshot.cash_before), after = moneyToCents(snapshot.cash_after);
    const priorTaxBefore = moneyToCents(snapshot.tax_before), priorTaxAfter = moneyToCents(snapshot.tax_after);
    if (priorAmount <= 0n || before < 0n || after - before !== priorAmount || after > gross
      || priorTaxBefore < 0n || priorTaxAfter < priorTaxBefore || priorTaxAfter !== divideHalfUp(totalTax * after, gross)
      || priorTaxBefore !== divideHalfUp(totalTax * before, gross)) invalid();
    let effect = 0n;
    const seen = new Set<string>();
    for (const entry of snapshot.entries) {
      const rate = normalizeRate(entry.tax_rate), tax = moneyToCents(entry.tax_amount);
      if (seen.has(rate) || !original.has(rate) || tax < 0n) invalid();
      seen.add(rate); effect += tax;
      recognized.set(rate, (recognized.get(rate) ?? 0n) + tax);
    }
    if (effect !== priorTaxAfter - priorTaxBefore) invalid();
    cashBefore += priorAmount; taxBefore += effect;
  }
  // Reject overlapping, missing or rewritten chains, irrespective of row ordering.
  if (taxBefore !== divideHalfUp(totalTax * cashBefore, gross)) invalid();
  const ranges = args.prior.map(snapshot => ({ before: moneyToCents(snapshot.cash_before), after: moneyToCents(snapshot.cash_after) }))
    .sort((a, b) => a.before < b.before ? -1 : a.before > b.before ? 1 : 0);
  let end = 0n;
  for (const range of ranges) { if (range.before !== end) invalid(); end = range.after; }
  if (end !== cashBefore || cashBefore + amount > gross) invalid();
  const cashAfter = cashBefore + amount, taxAfter = divideHalfUp(totalTax * cashAfter, gross);
  const remaining = [...original].map(([key, tax]) => {
    const weight = tax - (recognized.get(key) ?? 0n);
    if (weight < 0n) invalid();
    return { key, weight };
  });
  const delta = taxAfter - taxBefore;
  const allocated = delta === 0n ? new Map(remaining.map(item => [item.key, 0n])) : apportionExactCents(delta, remaining);
  const entries = remaining.sort((a, b) => a.key.localeCompare(b.key)).map(item => ({
    tax_rate: item.key, tax_amount: formatDecimal(allocated.get(item.key) ?? 0n, 2),
  }));
  return { version: 1, invoice_id: args.invoiceId, invoice_sha256: args.invoiceSha256,
    allocation_amount: formatDecimal(amount, 2), cash_before: formatDecimal(cashBefore, 2), cash_after: formatDecimal(cashAfter, 2),
    tax_before: formatDecimal(taxBefore, 2), tax_after: formatDecimal(taxAfter, 2), entries };
}
