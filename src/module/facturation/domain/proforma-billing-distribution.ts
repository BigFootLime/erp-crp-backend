import { HttpError } from "../../../utils/httpError";
import { computeExactDocumentTotals, formatDecimal, parseDecimal } from "./decimal-money";

export type ProformaBillingPart = { billedClientId: string; quantity: string };

/** Billing companies are selected records; amounts/prices come from the order. */
export function proformaBillingDistribution(args: {
  sourceQuantity: string;
  unitPriceExTax: string;
  discountPercent: string;
  globalDiscountPercent: string;
  taxRatePercent: string;
  parts: readonly ProformaBillingPart[];
}) {
  const quantity = parseDecimal(args.sourceQuantity, 3, "Quantité de l'affaire");
  if (quantity <= 0n || !args.parts.length) throw new HttpError(422, "PROFORMA_BILLING_DISTRIBUTION_REQUIRED", "Répartissez la quantité entre les sociétés facturées.");
  const clients = new Set<string>();
  let distributed = 0n;
  const parts = args.parts.map(part => {
    if (!part.billedClientId.trim() || part.billedClientId !== part.billedClientId.trim()
      || clients.has(part.billedClientId)) {
      throw new HttpError(422, "PROFORMA_BILLING_PARTY_INVALID", "Sélectionnez chaque société facturée une seule fois.");
    }
    clients.add(part.billedClientId);
    const partQuantity = parseDecimal(part.quantity, 3, "Quantité facturée à la société");
    if (partQuantity <= 0n) throw new HttpError(422, "PROFORMA_BILLING_QUANTITY_INVALID", "Chaque quantité facturée doit être positive.");
    distributed += partQuantity;
    const normalizedQuantity = formatDecimal(partQuantity, 3);
    const totals = computeExactDocumentTotals([{ quantity: normalizedQuantity, unitPriceExTax: args.unitPriceExTax,
      discountPercent: args.discountPercent, taxRatePercent: args.taxRatePercent }], args.globalDiscountPercent);
    return { billedClientId: part.billedClientId, quantity: normalizedQuantity,
      globalDiscountPercent: totals.discountPercent, globalDiscountAmount: totals.discountAmount,
      totalExTax: totals.totalExTax, taxAmount: totals.totalTax, totalInclTax: totals.totalInclTax };
  });
  if (distributed !== quantity) throw new HttpError(422, "PROFORMA_BILLING_QUANTITY_MISMATCH", "La répartition doit couvrir exactement la quantité de l'affaire.");
  // Each billed company gets a fiscal document with its own cent rounding.
  // Never silently rebalance a cent by modifying another company's price.
  return parts;
}
