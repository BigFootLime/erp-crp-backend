import { canonicalizeStockUnitCode } from "../../../shared/stock-unit";
import { decimal, proportionAmount, type MarginEvidence } from "./margin-engine";

export type SupplierCostSource = {
  key: string;
  category: "SUBCONTRACTING";
  amount_ht: string | null;
  source_type: string;
  source_ref: string;
  observed_at: string | null;
  source_reliability: MarginEvidence["source_reliability"];
  currency: string;
  source_document_type?: string;
  source_document_ref?: string;
  definition?: string;
};
export type SupplierReceiptCost = SupplierCostSource & {
  order_line_id: string;
  receipt_quantity: string;
  purchase_unit: string | null;
};
export type SupplierInvoiceCost = SupplierCostSource & {
  order_line_id: string;
  invoice_id: string;
  document_type: "INVOICE" | "CREDIT_NOTE";
  invoiced_quantity: string | null;
  invoice_unit: string | null;
  purchase_unit: string | null;
  purchase_currency: string;
  supplier_matches: boolean;
  receipt_links_valid: boolean;
  archive_ready: boolean;
  header_allocated: boolean;
};

function scaledText(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 1_000_000n}.${String(absolute % 1_000_000n).padStart(6, "0")}`;
}

function knownDecimal(value: string | null): bigint | null {
  if (value === null) return null;
  try { return decimal(value); } catch { return null; }
}

function comparableUnit(value: string | null): string | null {
  const unit = canonicalizeStockUnitCode(value);
  // UNECE Recommendation 20: C62 (one), H87 (piece), count units only.
  // Sources are recorded in ADR-0947; no length/mass conversion is inferred.
  return unit === "c62" || unit === "h87" ? "u" : unit;
}

function invoiceIssue(invoice: SupplierInvoiceCost): string | null {
  if (!invoice.supplier_matches) return "Fournisseur de facture différent de la commande.";
  if (!invoice.receipt_links_valid) return "Réceptions du rapprochement absentes, annulées ou incohérentes.";
  if (!invoice.archive_ready) return "Pièces de la facture non contrôlées ou non archivées.";
  if (!invoice.header_allocated) return "Frais ou remises de facture hors lignes : répartition à confirmer.";
  if (invoice.currency !== invoice.purchase_currency) return "Devise de facture différente de la commande : conversion non établie.";
  const invoiceUnit = comparableUnit(invoice.invoice_unit);
  const purchaseUnit = comparableUnit(invoice.purchase_unit);
  if (!invoiceUnit || !purchaseUnit || invoiceUnit !== purchaseUnit) return "Unité facturée différente ou inconnue : conversion non établie.";
  const amount = knownDecimal(invoice.amount_ht);
  const quantity = knownDecimal(invoice.invoiced_quantity);
  if (amount === null) return "Montant facturé inconnu ou invalide.";
  if (invoice.document_type === "INVOICE" && (quantity === null || quantity <= 0n || amount < 0n)) {
    return "Quantité facturée ou correction de ligne à réconcilier.";
  }
  return null;
}

/** Monetary attribution stays at the explicitly linked OF/order line. It does
 * not assign invoice costs to material lots or post stock/accounting entries. */
export function reconcileSupplierCostSources(receipts: SupplierReceiptCost[], invoices: SupplierInvoiceCost[]): SupplierCostSource[] {
  const lineIds = new Set([...receipts, ...invoices].map(row => row.order_line_id));
  const costs: SupplierCostSource[] = [];
  for (const lineId of lineIds) {
    const lineReceipts = receipts.filter(row => row.order_line_id === lineId);
    const lineInvoices = invoices.filter(row => row.order_line_id === lineId);
    if (!lineInvoices.length) { costs.push(...lineReceipts); continue; }

    const receiptQuantities = lineReceipts.map(row => knownDecimal(row.receipt_quantity));
    const receiptQuantityInvalid = receiptQuantities.some(quantity => quantity === null || quantity <= 0n);
    const received = receiptQuantities.reduce<bigint>((total, quantity) => total + (quantity ?? 0n), 0n);
    const billed = lineInvoices.filter(row => row.document_type === "INVOICE" && row.invoiced_quantity !== null)
      .reduce((total, row) => total + (knownDecimal(row.invoiced_quantity) ?? 0n), 0n);
    const invalidInvoice = lineInvoices.map(invoice => ({ invoice, issue: invoiceIssue(invoice) })).find(result => result.issue !== null);
    const issue = invalidInvoice?.issue
      ?? (receiptQuantityInvalid ? "Quantité de réception inconnue ou invalide."
        : received <= 0n ? "Aucune réception physique utilisable pour ce rapprochement."
        : billed > received ? "Quantité cumulée facturée supérieure aux réceptions physiques." : null);
    if (issue) {
      const evidenceInvoice = invalidInvoice?.invoice ?? lineInvoices[0];
      costs.push({ key: `supplier-invoice-allocation-missing:${lineId}`, category: "SUBCONTRACTING", amount_ht: null,
        source_type: "SUPPLIER_INVOICE_ALLOCATION_UNRESOLVED", source_ref: lineId,
        observed_at: evidenceInvoice.observed_at, source_reliability: "UNKNOWN", currency: evidenceInvoice.currency,
        source_document_type: "SUPPLIER_INVOICE", source_document_ref: evidenceInvoice.invoice_id, definition: issue });
      continue;
    }

    for (const invoice of lineInvoices) costs.push({ ...invoice, source_reliability: "VERIFIED",
      source_document_type: "SUPPLIER_INVOICE", source_document_ref: invoice.invoice_id,
      definition: "Montant HT de ligne rapprochée, approuvée et archivée, attribuée à cet OF." });
    const remaining = received - billed;
    if (remaining <= 0n) continue;
    const estimateAmounts = lineReceipts.map(row => knownDecimal(row.amount_ht));
    const estimateKnown = estimateAmounts.every(amount => amount !== null && amount >= 0n);
    const estimate = estimateKnown ? estimateAmounts.reduce<bigint>((total, amount) => total + (amount ?? 0n), 0n) : null;
    costs.push({ key: `supplier-receipt-unbilled:${lineId}`, category: "SUBCONTRACTING",
      amount_ht: estimate === null ? null : proportionAmount(scaledText(estimate), scaledText(remaining), scaledText(received)),
      source_type: "SUPPLIER_RECEPTION_UNBILLED_ESTIMATE", source_ref: lineId,
      observed_at: lineReceipts[0].observed_at, source_reliability: "DECLARED", currency: lineReceipts[0].currency,
      source_document_type: "COMMANDE_FOURNISSEUR_LIGNE", source_document_ref: lineId,
      definition: "Reliquat reçu non facturé, estimé au prix de commande ; hors unités déjà facturées." });
  }
  return costs;
}
