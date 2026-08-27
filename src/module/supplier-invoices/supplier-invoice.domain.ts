import crypto from "node:crypto";

import { HttpError } from "../../utils/httpError";
import type { SuperPdpEnInvoice, SuperPdpProviderInvoice } from "../facturation/electronic-invoicing/providers/super-pdp/super-pdp.client";

export const SUPPLIER_INVOICE_STATUSES = [
  "RECEIVED",
  "IDENTIFIED",
  "MATCHED",
  "PENDING_APPROVAL",
  "APPROVED",
  "ACCOUNTING_EXPORTED",
  "CLOSED",
  "DISPUTED",
  "REJECTED",
] as const;

export type SupplierInvoiceStatus = typeof SUPPLIER_INVOICE_STATUSES[number];
export type SupplierInvoiceDocumentType = "INVOICE" | "CREDIT_NOTE";

export type NormalizedSupplierInvoiceLine = Readonly<{
  providerLineId: string;
  position: number;
  designation: string;
  quantity: number | null;
  unitCode: string | null;
  unitPrice: number | null;
  netAmount: number;
  vatCategory: string | null;
  vatRate: number | null;
  purchaseOrderLineReference: string | null;
  articleBuyerReference: string | null;
  articleSellerReference: string | null;
  sourceSnapshot: Readonly<Record<string, unknown>>;
}>;

export type NormalizedSupplierInvoice = Readonly<{
  providerInvoiceId: string;
  providerCompanyId: number;
  providerCreatedAt: string;
  documentType: SupplierInvoiceDocumentType;
  providerTypeCode: number;
  legalNumber: string;
  issueDate: string;
  paymentDueDate: string | null;
  currency: string;
  purchaseOrderReference: string | null;
  totalWithoutVat: number;
  totalVat: number;
  totalWithVat: number;
  amountDue: number;
  vatBreakdown: readonly Readonly<Record<string, unknown>>[];
  sellerSnapshot: Readonly<Record<string, unknown>>;
  buyerSnapshot: Readonly<Record<string, unknown>>;
  sourceSnapshot: Readonly<Record<string, unknown>>;
  supplierSirens: readonly string[];
  supplierElectronicAddress: Readonly<{ scheme: string; value: string }> | null;
  supplierVatIdentifier: string | null;
  lines: readonly NormalizedSupplierInvoiceLine[];
  attachments: readonly Readonly<{
    providerKey: string;
    fileName: string;
    mimeType: string;
    content: Buffer;
  }>[];
}>;

function decimal(value: unknown, field: string): number {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).value
    : value;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 999_999_999_999) {
    throw new HttpError(422, "SUPPLIER_INVOICE_AMOUNT_INVALID", `Le montant ${field} est invalide.`);
  }
  return Math.round((parsed + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function optionalDecimal(value: unknown, field: string): number | null {
  return value === null || value === undefined || value === "" ? null : decimal(value, field);
}

function clean(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, max) : null;
}

function snapshot(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function documentType(typeCode: number): SupplierInvoiceDocumentType {
  return typeCode === 381 || typeCode === 396 ? "CREDIT_NOTE" : "INVOICE";
}

function sirenCandidates(enInvoice: SuperPdpEnInvoice): string[] {
  const seller = enInvoice.seller as Record<string, unknown>;
  const values: string[] = [];
  const legal = seller.legal_registration_identifier;
  if (legal && typeof legal === "object" && !Array.isArray(legal)) {
    const value = clean((legal as Record<string, unknown>).value);
    if (value) values.push(value);
  }
  const identifiers = Array.isArray(seller.identifiers) ? seller.identifiers : [];
  for (const identifier of identifiers) {
    if (identifier && typeof identifier === "object") {
      const value = clean((identifier as Record<string, unknown>).value);
      if (value) values.push(value);
    }
  }
  const vat = clean(seller.vat_identifier, 40)?.toUpperCase();
  if (vat && /^FR[A-Z0-9]{2}\d{9}$/.test(vat)) values.push(vat.slice(-9));
  return [...new Set(values.map((value) => value.replace(/\D/g, "")).filter((value) => value.length >= 9).map((value) => value.slice(0, 9)))];
}

function decodeAttachments(enInvoice: SuperPdpEnInvoice): NormalizedSupplierInvoice["attachments"] {
  const result: Array<{ providerKey: string; fileName: string; mimeType: string; content: Buffer }> = [];
  let totalBytes = 0;
  for (const item of enInvoice.additional_supporting_documents ?? []) {
    const attached = item.attached_document;
    if (!attached?.document) continue;
    const encoded = attached.document.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new HttpError(422, "SUPPLIER_INVOICE_ATTACHMENT_INVALID", "Une pièce jointe fournisseur n'est pas un contenu Base64 valide.");
    }
    const content = Buffer.from(encoded, "base64");
    totalBytes += content.length;
    if (content.length === 0 || content.length > 25 * 1024 * 1024 || totalBytes > 50 * 1024 * 1024) {
      throw new HttpError(413, "SUPPLIER_INVOICE_ATTACHMENT_TOO_LARGE", "Les pièces jointes de la facture fournisseur dépassent la limite autorisée.");
    }
    result.push({
      providerKey: item.key,
      fileName: attached.filename,
      mimeType: attached.mime_code.toLowerCase(),
      content,
    });
  }
  return result;
}

export function normalizeSuperPdpSupplierInvoice(invoice: SuperPdpProviderInvoice): NormalizedSupplierInvoice {
  if (invoice.direction !== "in" || !invoice.en_invoice) {
    throw new HttpError(422, "SUPPLIER_INVOICE_EN16931_REQUIRED", "La facture entrante SUPER PDP ne contient pas de représentation EN16931 complète.");
  }
  const en = invoice.en_invoice;
  if (en.lines.length === 0) {
    throw new HttpError(422, "SUPPLIER_INVOICE_LINES_REQUIRED", "La facture fournisseur ne contient aucune ligne exploitable.");
  }
  const vatBreakdown = en.vat_break_down.map((vat) => ({
    category: vat.vat_category_code,
    rate: optionalDecimal(vat.vat_category_rate, "taux TVA"),
    taxable_amount: decimal(vat.vat_category_taxable_amount, "base TVA"),
    tax_amount: decimal(vat.vat_category_tax_amount, "montant TVA"),
  }));
  const totalWithoutVat = decimal(en.totals.total_without_vat, "total HT");
  const totalWithVat = decimal(en.totals.total_with_vat, "total TTC");
  const totalVat = en.totals.total_vat_amount == null
    ? vatBreakdown.reduce((sum, item) => sum + Number(item.tax_amount), 0)
    : decimal(en.totals.total_vat_amount, "total TVA");
  if (Math.abs((totalWithoutVat + totalVat) - totalWithVat) > 0.02) {
    throw new HttpError(422, "SUPPLIER_INVOICE_TOTALS_INCONSISTENT", "Les totaux HT, TVA et TTC de la facture fournisseur sont incohérents.");
  }
  const lines = en.lines.map((line, index): NormalizedSupplierInvoiceLine => {
    const info = line.item_information;
    const price = line.price_details.item_net_price ?? line.price_details.item_gross_price;
    return {
      providerLineId: line.identifier,
      position: index + 1,
      designation: clean(info.name, 1000) ?? clean(info.description, 1000) ?? `Ligne ${index + 1}`,
      quantity: optionalDecimal(line.invoiced_quantity, "quantité facturée"),
      unitCode: clean(line.invoiced_quantity_code, 20),
      unitPrice: optionalDecimal(price, "prix unitaire"),
      netAmount: decimal(line.net_amount, "montant de ligne"),
      vatCategory: clean(line.vat_information?.vat_category_code, 20),
      vatRate: optionalDecimal(line.vat_information?.vat_category_rate, "taux TVA de ligne"),
      purchaseOrderLineReference: clean(
        line.referenced_purchase_order_line_reference ?? line.purchase_order_reference_from_buyer,
        200
      ),
      articleBuyerReference: clean(info.buyer_identifier, 200),
      articleSellerReference: clean(info.seller_identifier, 200),
      sourceSnapshot: snapshot(line),
    };
  });
  const sellerElectronicAddress = en.seller.electronic_address
    ? { scheme: en.seller.electronic_address.scheme.toUpperCase(), value: en.seller.electronic_address.value }
    : null;
  return {
    providerInvoiceId: String(invoice.id),
    providerCompanyId: invoice.company_id,
    providerCreatedAt: invoice.created_at,
    documentType: documentType(en.type_code),
    providerTypeCode: en.type_code,
    legalNumber: en.number,
    issueDate: en.issue_date,
    paymentDueDate: en.payment_due_date ?? null,
    currency: en.currency_code,
    purchaseOrderReference: en.purchase_order_reference ?? null,
    totalWithoutVat,
    totalVat: Math.round((totalVat + Number.EPSILON) * 100) / 100,
    totalWithVat,
    amountDue: decimal(en.totals.amount_due_for_payment, "net à payer"),
    vatBreakdown,
    sellerSnapshot: snapshot(en.seller),
    buyerSnapshot: snapshot(en.buyer),
    sourceSnapshot: snapshot(en),
    supplierSirens: sirenCandidates(en),
    supplierElectronicAddress: sellerElectronicAddress,
    supplierVatIdentifier: clean(en.seller.vat_identifier, 40)?.toUpperCase() ?? null,
    lines,
    attachments: decodeAttachments(en),
  };
}

export function supplierInvoiceContentSha256(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function supplierInvoiceRequestHash(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
