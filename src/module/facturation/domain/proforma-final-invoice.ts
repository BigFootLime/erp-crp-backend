import { HttpError } from "../../../utils/httpError";
import { formatDecimal, parseDecimal } from "./decimal-money";

/** One physical affair, irrespective of the number of lots used by its BL line. */
export type FinalInvoiceAffair = {
  allocation_id: string;
  delivered_quantity: string;
  quantity_already_selected: string;
  requirement: string;
  proforma_id: string | null;
  proforma_reference: string | null;
  proforma_status: string | null;
  currency: string | null;
  billing_part_id: string | null;
  billed_client_id: string | null;
  billed_client_name: string | null;
  billed_client_blocked: boolean | null;
  part_quantity: string | null;
  part_already_selected: string | null;
  unit_price_ex_tax: string | null;
  discount_percent: string | null;
  global_discount_percent: string | null;
  tax_rate_percent: string | null;
  source_revision: string | null;
};

export type FinalInvoiceContribution = {
  billing_part_id: string;
  allocation_id: string;
  quantity: string;
};

export type FinalInvoiceAuthority = {
  capacity: string;
  proforma_id: string;
  proforma_reference: string;
  billed_client_name: string;
  unit_price_ex_tax: string;
  discount_percent: string;
  global_discount_percent: string;
  tax_rate_percent: string;
  source_revision: string;
  contributions: FinalInvoiceContribution[];
};

/**
 * Explicit company quotas govern partial deliveries. Do not invent fractional
 * prorating across BLs, reopen a delivered quantity after a credit, or consume
 * the same physical affair for several companies. The caller excludes only
 * this invoice's own retained selections when revalidating its preview.
 */
export function planProformaFinalInvoice(args: {
  affairs: readonly FinalInvoiceAffair[];
  quantity?: string;
  sourceQuantity: string;
  remainingSourceQuantity: string;
  billedClientId: string;
  currency: string;
}): FinalInvoiceAuthority | null {
  if (!args.affairs.some(affair => affair.requirement === "PROFORMA")) return null;
  const fail = (code: string, message: string): never => { throw new HttpError(409, code, message); };
  const quantity = (value: string) => parseDecimal(value, 3, "Quantité facturable");
  const affairs = [...args.affairs].sort((a, b) => a.allocation_id.localeCompare(b.allocation_id, "en", { numeric: true }));
  const proformaIds = new Set(affairs.map(affair => affair.proforma_id));
  if (proformaIds.size !== 1 || affairs.some(affair => affair.requirement !== "PROFORMA"
    || !affair.proforma_id || affair.proforma_status !== "ISSUED" || affair.currency !== args.currency)) {
    fail("PROFORMA_FINAL_SOURCE_SCOPE_INVALID", "Le BL doit appartenir à une seule proforma émise, dans la devise de la facture.");
  }
  if (new Set(affairs.map(affair => affair.allocation_id)).size !== affairs.length
    || affairs.reduce((sum, affair) => sum + quantity(affair.delivered_quantity), 0n) !== quantity(args.sourceQuantity)) {
    fail("PROFORMA_FINAL_PHYSICAL_SOURCE_INVALID", "Vérifiez les affaires et les quantités physiques de cette ligne de BL.");
  }
  const eligible = affairs.filter(affair => affair.billing_part_id && affair.billed_client_id === args.billedClientId);
  if (!eligible.length) fail("SOURCE_CLIENT_MISMATCH", "Cette société ne figure pas dans la répartition validée de la proforma.");
  if (eligible.some(affair => affair.billed_client_blocked)) fail("CLIENT_BLOCKED", "La société facturée est bloquée.");
  if (eligible.some(affair => affair.part_quantity === null || affair.part_already_selected === null
    || affair.unit_price_ex_tax === null || affair.discount_percent === null || affair.global_discount_percent === null
    || affair.tax_rate_percent === null || affair.source_revision === null || !affair.proforma_reference)) {
    fail("PROFORMA_FINAL_PRICING_REQUIRED", "Les conditions figées de la proforma doivent être disponibles.");
  }
  const available = eligible.map(affair => {
    const physical = quantity(affair.delivered_quantity) - quantity(affair.quantity_already_selected);
    const quota = quantity(affair.part_quantity!) - quantity(affair.part_already_selected!);
    if (physical < 0n || quota < 0n) fail("PROFORMA_FINAL_BUDGET_INCONSISTENT", "Les quantités déjà facturées doivent être vérifiées.");
    return { affair, quantity: physical < quota ? physical : quota };
  });
  const quotaCapacity = available.reduce((sum, item) => sum + item.quantity, 0n);
  const physicalCapacity = quantity(args.remainingSourceQuantity);
  const capacity = physicalCapacity < quotaCapacity ? physicalCapacity : quotaCapacity;
  if (capacity < 0n) fail("PROFORMA_FINAL_BUDGET_INCONSISTENT", "Les quantités déjà facturées doivent être vérifiées.");
  const selected = args.quantity === undefined ? capacity : quantity(args.quantity);
  if (args.quantity !== undefined && (selected <= 0n || selected > capacity)) {
    fail("PROFORMA_FINAL_QUANTITY_EXCEEDED", "La quantité dépasse le solde livré attribué à cette société.");
  }
  let remaining = selected;
  const contributions: FinalInvoiceContribution[] = [];
  const pricingSources: FinalInvoiceAffair[] = [];
  for (const { affair, quantity } of available) {
    const taken = remaining < quantity ? remaining : quantity;
    if (taken > 0n) {
      contributions.push({ billing_part_id: affair.billing_part_id!, allocation_id: affair.allocation_id, quantity: formatDecimal(taken, 3) });
      pricingSources.push(affair);
      remaining -= taken;
    }
    if (remaining === 0n) break;
  }
  const first = pricingSources[0] ?? eligible[0]!;
  for (const field of ["unit_price_ex_tax", "discount_percent", "global_discount_percent", "tax_rate_percent"] as const) {
    if (pricingSources.some(source => parseDecimal(source[field]!, 4, "Condition commerciale") !== parseDecimal(first[field]!, 4, "Condition commerciale"))) {
      fail("PROFORMA_FINAL_PRICING_MIXED", "Cette ligne réunit plusieurs conditions commerciales : préparez des lignes de BL distinctes.");
    }
  }
  return {
    capacity: formatDecimal(capacity, 3), proforma_id: first.proforma_id!, proforma_reference: first.proforma_reference!,
    billed_client_name: first.billed_client_name ?? args.billedClientId, unit_price_ex_tax: first.unit_price_ex_tax!,
    discount_percent: first.discount_percent!, global_discount_percent: first.global_discount_percent!,
    tax_rate_percent: first.tax_rate_percent!, source_revision: pricingSources.map(source => `${source.allocation_id}:${source.source_revision}`).join("|"),
    contributions,
  };
}
