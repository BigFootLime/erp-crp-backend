import { HttpError } from "../../../../utils/httpError";
import type { CutoverRow } from "../../types/data-cutover.types";

export type OrderRemainderDomain = "SALES_ORDER" | "SUPPLIER_ORDER" | "INTERNAL_DEMAND";
export type ResolvedOrderLine = {
  rowId: string;
  legacyKey: string;
  articleId: string;
  articleReference: string;
  quantity: string;
  unit: string;
  unitPrice: string | null;
  vatRate: string | null;
  evidenceReference: string | null;
  historicalAffairReference: string | null;
  plannedDueDate: string;
};
export type CustomerOrderClassification =
  | { kind: "FERME"; evidenceReference: string }
  | { kind: "CADRE_RELEASE"; contractTargetId: string; evidenceReference: string }
  | { kind: "UNKNOWN" };
export type CustomerOrderDraft = {
  kind: "CUSTOMER";
  customerId: string;
  customerOrderNumber: string;
  currency: string;
  plannedDueDate: string;
  orderDate: string;
  classification: Exclude<CustomerOrderClassification, { kind: "UNKNOWN" }>;
  historicalReferences: string[];
  lines: ResolvedOrderLine[];
};
export type SupplierOrderDraft = {
  kind: "SUPPLIER";
  supplierId: string;
  supplierOrderNumber: string;
  currency: string;
  plannedDueDate: string;
  orderDate: string;
  historicalReferences: string[];
  lines: ResolvedOrderLine[];
};
export type InternalDemandDraft = {
  kind: "INTERNAL";
  historicalReference: string;
  orderDate: string;
  plannedDueDate: string;
  lines: ResolvedOrderLine[];
};
export type OrderRemainderDraft = CustomerOrderDraft | SupplierOrderDraft | InternalDemandDraft;

/**
 * Native writers are intentionally injected. Their final implementation must
 * use the caller's PoolClient and must not queue an AR/PDF/e-mail, delivery,
 * stock receipt or OF. This preserves atomic crosswalk creation by the caller.
 */
export type NativeOrderDraftWriterTx = {
  createCustomerDraft(tx: unknown, draft: CustomerOrderDraft): Promise<{ id: string; reference: string }>;
  createSupplierDraft(tx: unknown, draft: SupplierOrderDraft): Promise<{ id: string; reference: string }>;
  createInternalDemandDraft(tx: unknown, draft: InternalDemandDraft): Promise<{ id: string; reference: string }>;
};

export type OrderReferenceResolverTx = {
  customerId(tx: unknown, legacyCustomerCode: string): Promise<string | null>;
  supplierId(tx: unknown, legacySupplierCode: string): Promise<string | null>;
  articleId(tx: unknown, legacyArticleReference: string): Promise<string | null>;
};

const positiveDecimal = (value: unknown, label: string): string => {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim().replace(",", ".") : "";
  if (!/^\d+(?:\.\d{1,3})?$/.test(text) || Number(text) <= 0) {
    throw new HttpError(422, "CUTOVER_ORDER_REMAINDER_INVALID", `${label} doit être une quantité strictement positive, avec trois décimales au maximum.`);
  }
  return text;
};
const text = (values: CutoverRow["values"], key: string, label: string): string => {
  const value = values[key];
  if (typeof value !== "string" || !value.trim()) throw new HttpError(422, "CUTOVER_ORDER_REMAINDER_REQUIRED", `${label} doit être confirmé avant la création du brouillon.`);
  return value.trim();
};
const optionalText = (values: CutoverRow["values"], key: string) => {
  const value = values[key];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

export async function buildOrderRemainderDraftsTx(params: {
  tx: unknown;
  rows: CutoverRow[];
  resolver: OrderReferenceResolverTx;
}): Promise<OrderRemainderDraft[]> {
  const groups = new Map<string, OrderRemainderDraft>();
  for (const row of params.rows) {
    if (!["SALES_ORDER", "SUPPLIER_ORDER", "INTERNAL_DEMAND"].includes(row.domain)) {
      throw new HttpError(422, "CUTOVER_ORDER_DOMAIN_INVALID", "Cette fiche ne correspond pas à une commande ou un besoin à poursuivre.");
    }
    if (row.decision !== "INCLUDE" || row.status !== "READY") {
      throw new HttpError(409, "CUTOVER_ORDER_ROW_NOT_READY", "Chaque fiche retenue doit être validée et sans anomalie avant création du brouillon.");
    }
    const quantity = positiveDecimal(row.values.quantityRemaining, "Le reliquat");
    const articleReference = text(row.values, "articleReference", "La référence article");
    const explicitArticleId = optionalText(row.values, "articleTargetId");
    const articleId = explicitArticleId ?? await params.resolver.articleId(params.tx, articleReference);
    if (!articleId) throw new HttpError(422, "CUTOVER_ORDER_ARTICLE_UNRESOLVED", "Rapprocher explicitement l'article CERP avant de créer le brouillon.");
    const line: ResolvedOrderLine = {
      rowId: row.id, legacyKey: row.legacy_key, articleId, articleReference, quantity,
      unit: text(row.values, "unit", "L'unité"),
      unitPrice: optionalText(row.values, "unitPrice"), vatRate: optionalText(row.values, "vatRate"),
      evidenceReference: optionalText(row.values, "priceEvidence"), historicalAffairReference: optionalText(row.values, "affairNumber"),
      plannedDueDate: text(row.values, "plannedDueDate", "Le délai confirmé"),
    };
    if (row.domain === "SALES_ORDER") {
      const customerCode = text(row.values, "customerCode", "Le client");
      const explicitCustomerId = optionalText(row.values, "customerTargetId");
      const customerId = explicitCustomerId ?? await params.resolver.customerId(params.tx, customerCode);
      if (!customerId) throw new HttpError(422, "CUTOVER_ORDER_CUSTOMER_UNRESOLVED", "Rapprocher explicitement le client CERP avant de créer le brouillon.");
      const customerOrderNumber = text(row.values, "customerOrderNumber", "Le numéro de commande client");
      const orderDate = text(row.values, "orderDate", "La date de commande");
      const currency = text(row.values, "currency", "La devise");
      const orderType = optionalText(row.values, "orderType") ?? "UNKNOWN";
      const evidenceReference = optionalText(row.values, "orderEvidence") ?? "";
      const contractTargetId = optionalText(row.values, "contractTargetId");
      const classification: CustomerOrderClassification = orderType === "FERME"
        ? { kind: "FERME", evidenceReference }
        : orderType === "CADRE_RELEASE"
          ? { kind: "CADRE_RELEASE", contractTargetId: contractTargetId ?? "", evidenceReference }
          : { kind: "UNKNOWN" };
      if (classification.kind === "UNKNOWN") throw new HttpError(422, "CUTOVER_ORDER_CLASSIFICATION_REQUIRED", "Qualifier cette commande comme ponctuelle ou appel de contrat avec une preuve explicite.");
      if (!classification.evidenceReference.trim() || (classification.kind === "CADRE_RELEASE" && !classification.contractTargetId.trim())) {
        throw new HttpError(422, "CUTOVER_ORDER_CLASSIFICATION_INVALID", "La classification de commande doit conserver son justificatif et, pour un appel de contrat, le contrat CERP confirmé.");
      }
      for (const existing of groups.values()) if (existing.kind === "CUSTOMER" && existing.customerId === customerId && existing.customerOrderNumber === customerOrderNumber) {
        const contractMismatch = existing.classification.kind === "CADRE_RELEASE" && classification.kind === "CADRE_RELEASE" && existing.classification.contractTargetId !== classification.contractTargetId;
        if (existing.currency !== currency || existing.orderDate !== orderDate || existing.classification.kind !== classification.kind || contractMismatch) {
          throw new HttpError(422, "CUTOVER_ORDER_HEADER_CONFLICT", "Le meme client et PO portent des valeurs d'entete contradictoires (devise, date ou type de commande). Verifier la source avant creation.");
        }
      }
      const key = `CUSTOMER\u0000${customerId}\u0000${customerOrderNumber}`;
      const current = groups.get(key) as CustomerOrderDraft | undefined;
      if (current) { current.lines.push(line); current.historicalReferences.push(row.legacy_key); }
      else groups.set(key, { kind: "CUSTOMER", customerId, customerOrderNumber, currency, plannedDueDate: line.plannedDueDate, orderDate, classification, historicalReferences: [row.legacy_key], lines: [line] });
      continue;
    }
    if (row.domain === "SUPPLIER_ORDER") {
      const supplierCode = text(row.values, "supplierCode", "Le fournisseur");
      const explicitSupplierId = optionalText(row.values, "supplierTargetId");
      const supplierId = explicitSupplierId ?? await params.resolver.supplierId(params.tx, supplierCode);
      if (!supplierId) throw new HttpError(422, "CUTOVER_ORDER_SUPPLIER_UNRESOLVED", "Rapprocher explicitement le fournisseur CERP avant de créer le brouillon.");
      const supplierOrderNumber = text(row.values, "supplierOrderNumber", "Le numéro de commande fournisseur");
      const orderDate = text(row.values, "orderDate", "La date de commande fournisseur");
      const currency = text(row.values, "currency", "La devise");
      const key = `SUPPLIER\u0000${supplierId}\u0000${supplierOrderNumber}`;
      const current = groups.get(key) as SupplierOrderDraft | undefined;
      if (current) {
        if (current.currency !== currency || current.orderDate !== orderDate) throw new HttpError(422, "CUTOVER_ORDER_HEADER_CONFLICT", "Le meme fournisseur et BC portent une devise ou date contradictoire. Verifier la source avant creation.");
        current.lines.push(line); current.historicalReferences.push(row.legacy_key);
      }
      else groups.set(key, { kind: "SUPPLIER", supplierId, supplierOrderNumber, currency, plannedDueDate: line.plannedDueDate, orderDate, historicalReferences: [row.legacy_key], lines: [line] });
      continue;
    }
    const historicalReference = text(row.values, "affairNumber", "La référence interne");
    const orderDate = text(row.values, "orderDate", "La date source du besoin interne");
    const plannedDueDate = text(row.values, "plannedDueDate", "La date souhaitée");
    groups.set(`INTERNAL\u0000${row.id}`, { kind: "INTERNAL", historicalReference, orderDate, plannedDueDate, lines: [line] });
  }
  return [...groups.values()];
}
