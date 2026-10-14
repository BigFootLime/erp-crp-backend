import { HttpError } from "../../../utils/httpError";
import { divideHalfUp, formatDecimal, moneyToCents, parseDecimal } from "./decimal-money";
import { apportionExactCents } from "./final-prepayment-targets";

export type DocumentTaxLine = {
  ratePercent: string;
  net: string;
  tax: string;
};

export type DocumentTaxBreakdown = {
  version: 1;
  subtotal_ex_tax: string;
  allowance_ex_tax: string;
  total_ex_tax: string;
  total_tax: string;
  total_incl_tax: string;
  entries: Array<{
    rate_percent: string;
    subtotal_ex_tax: string;
    allowance_ex_tax: string;
    taxable_amount: string;
    tax_amount: string;
  }>;
};

function invalid(): never {
  throw new HttpError(409, "DOCUMENT_TAX_BREAKDOWN_INVALID", "La ventilation de TVA ne correspond pas aux montants de la facture.");
}

/**
 * Distribute the authoritative document totals, never reprice an issued invoice.
 * A global allowance reduces its taxable bases. Largest remainders preserve
 * every declared cent across VAT groups and avoid floating-point arithmetic.
 */
export function allocateDocumentTaxBreakdown(args: {
  lines: readonly DocumentTaxLine[];
  totalExTax: string;
  totalTax: string;
  totalInclTax: string;
}): DocumentTaxBreakdown {
  const net = moneyToCents(args.totalExTax), tax = moneyToCents(args.totalTax), gross = moneyToCents(args.totalInclTax);
  if (net < 0n || tax < 0n || gross !== net + tax) invalid();
  const groups = new Map<string, { rate: bigint; net: bigint; tax: bigint }>();
  for (const line of args.lines) {
    const rate = parseDecimal(line.ratePercent, 4, "Taux de TVA");
    const lineNet = moneyToCents(line.net), lineTax = moneyToCents(line.tax);
    if (rate < 0n || rate > 1_000_000n || lineNet < 0n || lineTax < 0n || (rate === 0n && lineTax !== 0n)) invalid();
    const key = formatDecimal(rate, 4), group = groups.get(key) ?? { rate, net: 0n, tax: 0n };
    group.net += lineNet; group.tax += lineTax; groups.set(key, group);
  }
  const subtotal = [...groups.values()].reduce((sum, group) => sum + group.net, 0n);
  if (net > subtotal || (!groups.size && gross !== 0n)) invalid();
  const bases = apportionExactCents(net, [...groups].map(([key, group]) => ({ key, weight: group.net })));
  const retainedTax = [...groups.values()].reduce((sum, group) => sum + group.tax, 0n);
  const taxes = net === subtotal && tax === retainedTax
    ? new Map([...groups].map(([key, group]) => [key, group.tax]))
    : apportionExactCents(tax, [...groups].map(([key, group]) => ({ key, weight: bases.get(key)! * group.rate })));
  const entries = [...groups].sort((a,b) => a[1].rate < b[1].rate ? -1 : a[1].rate > b[1].rate ? 1 : 0).map(([key, group]) => {
    const base = bases.get(key)!, allocatedTax = taxes.get(key)!;
    // EN16931 BR-S-09 permits line-rounding differences strictly below one
    // monetary unit. Preserve declared line-rounded VAT; reject incoherence.
    const expectedTax = divideHalfUp(base * group.rate, 1_000_000n);
    const difference = allocatedTax > expectedTax ? allocatedTax - expectedTax : expectedTax - allocatedTax;
    if ((group.rate === 0n && allocatedTax !== 0n) || difference >= 100n) invalid();
    return {rate_percent:key,subtotal_ex_tax:formatDecimal(group.net,2),allowance_ex_tax:formatDecimal(group.net-base,2),
      taxable_amount:formatDecimal(base,2),tax_amount:formatDecimal(allocatedTax,2)};
  });
  return {version:1,subtotal_ex_tax:formatDecimal(subtotal,2),allowance_ex_tax:formatDecimal(subtotal-net,2),
    total_ex_tax:formatDecimal(net,2),total_tax:formatDecimal(tax,2),total_incl_tax:formatDecimal(gross,2),entries};
}

/** Resolve a frozen model or reconstruct only from retained monetary facts. */
export function documentTaxBreakdownFromSnapshot(args: {
  snapshot: unknown;
  lines: readonly DocumentTaxLine[];
  totalExTax: string;
  totalTax: string;
  totalInclTax: string;
}): DocumentTaxBreakdown {
  const calculated = allocateDocumentTaxBreakdown(args);
  const stored = args.snapshot && typeof args.snapshot === "object" && !Array.isArray(args.snapshot)
    ? (args.snapshot as Record<string,unknown>).tax_breakdown : undefined;
  if (stored === undefined) return calculated;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) invalid();
  const value=stored as Record<string,unknown>;
  if (value.version !== 1 || !Array.isArray(value.entries)) invalid();
  for (const key of ["subtotal_ex_tax","allowance_ex_tax","total_ex_tax","total_tax","total_incl_tax"] as const) {
    if (value[key] !== calculated[key]) invalid();
  }
  if (value.entries.length !== calculated.entries.length) invalid();
  for (let i=0;i<calculated.entries.length;i++) {
    const entry=value.entries[i];
    if (!entry || typeof entry!=="object" || Array.isArray(entry)) invalid();
    for (const key of Object.keys(calculated.entries[i]) as Array<keyof DocumentTaxBreakdown["entries"][number]>) {
      if ((entry as Record<string,unknown>)[key]!==calculated.entries[i][key]) invalid();
    }
  }
  return calculated;
}
