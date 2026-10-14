import { HttpError } from "../../../utils/httpError";
import { divideHalfUp, formatDecimal, moneyToCents, parseDecimal } from "./decimal-money";
import { apportionExactCents } from "./final-prepayment-targets";
import { readAdvanceCreditVat, type AdvanceCreditVatSnapshot } from "./advance-credit-vat";
import type { AdvanceVatSnapshot } from "./advance-vat";

function invalid(): never {
  throw new HttpError(409, "ADVANCE_VAT_EVIDENCE_INVALID", "Les avoirs et encaissements de cet acompte doivent être rapprochés avant ce paiement.");
}
const cents = moneyToCents;
function rate(value: string): string {
  const parsed = parseDecimal(value, 4, "Taux de TVA");
  if (parsed < 0n || parsed > 1_000_000n) invalid();
  return formatDecimal(parsed, 4);
}

/** An issued credit cancels pending VAT first. Subsequent receipts recognize
 * only the remaining pending VAT against the remaining debt. Previously frozen
 * effects are never repriced, moved between categories or booked a second time. */
export function planAdjustedAdvanceVat(args: {
  invoiceId: number; invoiceSha256: string; invoiceGross: string; allocationAmount: string;
  originalTax: ReadonlyArray<{ tax_rate: string; tax_amount: string }>;
  prior: readonly AdvanceVatSnapshot[]; credits: readonly AdvanceCreditVatSnapshot[]; refundedGross: string;
}): AdvanceVatSnapshot {
  const gross = cents(args.invoiceGross), amount = cents(args.allocationAmount), refunded = cents(args.refundedGross);
  if (!Number.isSafeInteger(args.invoiceId) || args.invoiceId <= 0 || !/^[a-f0-9]{64}$/.test(args.invoiceSha256)
    || gross <= 0n || amount <= 0n || refunded < 0n || !args.credits.length) invalid();
  const original = new Map<string, bigint>();
  for (const entry of args.originalTax) {
    const key = rate(entry.tax_rate), tax = cents(entry.tax_amount);
    if (original.has(key) || tax < 0n || (key === "0.0000" && tax !== 0n)) invalid();
    original.set(key, tax);
  }
  const totalTax = [...original.values()].reduce((sum, value) => sum + value, 0n);
  if (!original.size || totalTax >= gross) invalid();
  const creditPending = new Map<string, bigint>(), creditCollected = new Map<string, bigint>();
  let creditedGross = 0n;
  for (const credit of args.credits) {
    const qualified = readAdvanceCreditVat(credit, credit.total_ex_tax, credit.total_tax, credit.total_incl_tax);
    if (qualified.invoice_id !== args.invoiceId || qualified.invoice_sha256 !== args.invoiceSha256) invalid();
    creditedGross += cents(qualified.total_incl_tax);
    for (const entry of qualified.entries) {
      const key = rate(entry.tax_rate);
      if (!original.has(key)) invalid();
      creditPending.set(key, (creditPending.get(key) ?? 0n) + cents(entry.pending_tax));
      creditCollected.set(key, (creditCollected.get(key) ?? 0n) + cents(entry.collected_tax));
    }
  }
  if (creditedGross > gross || refunded > creditedGross) invalid();
  const totalCreditPending = [...creditPending.values()].reduce((sum, tax) => sum + tax, 0n);
  const totalCreditCollected = [...creditCollected.values()].reduce((sum, tax) => sum + tax, 0n);
  let cash = 0n, tax = 0n, lastCredit = 0n, lastRefund = 0n;
  const recognized = new Map<string, bigint>();
  const ordered = [...args.prior].sort((a, b) => cents(a.cash_before) < cents(b.cash_before) ? -1 : 1);
  for (const snapshot of ordered) {
    if (!snapshot || ![1, 2].includes(snapshot.version) || snapshot.invoice_id !== args.invoiceId
      || snapshot.invoice_sha256 !== args.invoiceSha256 || !Array.isArray(snapshot.entries)) invalid();
    const paid = cents(snapshot.allocation_amount), after = cents(snapshot.cash_after), taxAfter = cents(snapshot.tax_after);
    if (paid <= 0n || cents(snapshot.cash_before) !== cash || after !== cash + paid || after > gross
      || cents(snapshot.tax_before) !== tax || taxAfter < tax) invalid();
    let expected: bigint;
    if (snapshot.version === 1) {
      if (lastCredit !== 0n || tax !== divideHalfUp(totalTax * cash, gross)) invalid();
      expected = divideHalfUp(totalTax * after, gross) - tax;
    } else {
      const basis = snapshot.adjustment;
      if (!basis || !Array.isArray(basis.credit_pending_by_tax)) invalid();
      const credit = cents(basis.credited_gross), refund = cents(basis.refunded_gross),
        pendingCorrection = cents(basis.credited_pending_tax), collectedCorrection = cents(basis.credited_collected_tax);
      const due = gross - credit - cash + refund, pending = totalTax - pendingCorrection - tax;
      if (credit < lastCredit || credit > creditedGross || refund < lastRefund || refund > refunded
        || refund > cash || refund > credit || (refund > 0n && refund > cash + credit - gross) || due <= 0n || paid > due || pending < 0n
        || pendingCorrection < 0n || pendingCorrection > totalCreditPending || collectedCorrection < 0n
        || collectedCorrection > totalCreditCollected || cents(basis.due_before) !== due || cents(basis.pending_tax_before) !== pending) invalid();
      let sum = 0n; const seen = new Set<string>();
      for (const entry of basis.credit_pending_by_tax) {
        const key = rate(entry.tax_rate), value = cents(entry.tax_amount);
        if (seen.has(key) || !original.has(key) || value < 0n || value > (creditPending.get(key) ?? 0n)) invalid();
        seen.add(key); sum += value;
      }
      if (sum !== pendingCorrection) invalid();
      expected = divideHalfUp(pending * paid, due);
      lastCredit = credit; lastRefund = refund;
    }
    let effect = 0n; const seen = new Set<string>();
    for (const entry of snapshot.entries) {
      const key = rate(entry.tax_rate), value = cents(entry.tax_amount);
      if (seen.has(key) || !original.has(key) || value < 0n) invalid();
      seen.add(key); effect += value; recognized.set(key, (recognized.get(key) ?? 0n) + value);
    }
    if (effect !== expected || taxAfter - tax !== effect) invalid();
    cash = after; tax = taxAfter;
  }
  const due = gross - creditedGross - cash + refunded, pending = totalTax - totalCreditPending - tax;
  if (refunded > cash || (refunded > 0n && refunded > cash + creditedGross - gross)
    || due <= 0n || amount > due || pending < 0n || totalCreditCollected > tax) invalid();
  const remaining = [...original].map(([key, value]) => {
    const weight = value - (recognized.get(key) ?? 0n) - (creditPending.get(key) ?? 0n);
    if (weight < 0n || (creditCollected.get(key) ?? 0n) > (recognized.get(key) ?? 0n)) invalid();
    return { key, weight };
  });
  const delta = divideHalfUp(pending * amount, due);
  const allocated = delta === 0n ? new Map(remaining.map(item => [item.key, 0n])) : apportionExactCents(delta, remaining);
  return { version: 2, invoice_id: args.invoiceId, invoice_sha256: args.invoiceSha256,
    allocation_amount: formatDecimal(amount, 2), cash_before: formatDecimal(cash, 2), cash_after: formatDecimal(cash + amount, 2),
    tax_before: formatDecimal(tax, 2), tax_after: formatDecimal(tax + delta, 2),
    entries: remaining.sort((a, b) => a.key.localeCompare(b.key)).map(item => ({ tax_rate: item.key, tax_amount: formatDecimal(allocated.get(item.key) ?? 0n, 2) })),
    adjustment: { credited_gross: formatDecimal(creditedGross, 2), refunded_gross: formatDecimal(refunded, 2),
      credited_pending_tax: formatDecimal(totalCreditPending, 2), credited_collected_tax: formatDecimal(totalCreditCollected, 2),
      due_before: formatDecimal(due, 2), pending_tax_before: formatDecimal(pending, 2),
      credit_pending_by_tax: [...creditPending].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ tax_rate: key, tax_amount: formatDecimal(value, 2) })) } };
}
