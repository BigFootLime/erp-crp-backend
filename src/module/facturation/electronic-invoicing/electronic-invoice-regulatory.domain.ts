import { HttpError } from "../../../utils/httpError";
import { DGFiP_EINVOICE_SPEC_VERSION } from "./electronic-invoice.domain";

export const EINVOICE_BILLING_FRAME_CATALOG_VERSION =
  "AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30" as const;

export const EINVOICE_OPERATION_CATEGORIES = ["GOODS", "SERVICES", "MIXED"] as const;
export type ElectronicInvoiceOperationCategory =
  (typeof EINVOICE_OPERATION_CATEGORIES)[number];

export const EINVOICE_TRANSACTION_SCOPES = [
  "FR_PRIVATE_B2B",
  "FR_PUBLIC",
  "FOREIGN_B2B",
  "B2C",
  "OUT_OF_SCOPE",
] as const;
export type ElectronicInvoiceTransactionScope =
  (typeof EINVOICE_TRANSACTION_SCOPES)[number];

export const EINVOICE_BILLING_FRAMES = {
  B1: { operationCategory: "GOODS", label: "Facture de biens" },
  S1: { operationCategory: "SERVICES", label: "Facture de prestations de services" },
  M1: { operationCategory: "MIXED", label: "Facture mixte de biens et services" },
  B2: { operationCategory: "GOODS", label: "Facture de biens déjà payée" },
  S2: { operationCategory: "SERVICES", label: "Facture de services déjà payée" },
  M2: { operationCategory: "MIXED", label: "Facture mixte déjà payée" },
  B4: { operationCategory: "GOODS", label: "Facture définitive de biens après acompte" },
  S4: { operationCategory: "SERVICES", label: "Facture définitive de services après acompte" },
  M4: { operationCategory: "MIXED", label: "Facture définitive mixte après acompte" },
  S5: { operationCategory: "SERVICES", label: "Facture de sous-traitance" },
  S6: { operationCategory: "SERVICES", label: "Facture de cotraitance" },
  B7: { operationCategory: "GOODS", label: "Facture de biens déjà déclarée en e-reporting" },
  S7: { operationCategory: "SERVICES", label: "Facture de services déjà déclarée en e-reporting" },
} as const satisfies Readonly<
  Record<string, { operationCategory: ElectronicInvoiceOperationCategory; label: string }>
>;

export type ElectronicInvoiceBillingFrameCode = keyof typeof EINVOICE_BILLING_FRAMES;
export const EINVOICE_BILLING_FRAME_CODES = Object.keys(
  EINVOICE_BILLING_FRAMES
) as [ElectronicInvoiceBillingFrameCode, ...ElectronicInvoiceBillingFrameCode[]];

export type ElectronicAddress = {
  scheme: string;
  value: string;
  directoryEntryId: string | null;
  verifiedAt: string | null;
};

export type InvoiceRegulatorySnapshot = {
  specVersion: typeof DGFiP_EINVOICE_SPEC_VERSION;
  billingFrameCatalogVersion: typeof EINVOICE_BILLING_FRAME_CATALOG_VERSION;
  billingFrameCode: ElectronicInvoiceBillingFrameCode;
  operationCategory: ElectronicInvoiceOperationCategory;
  transactionScope: ElectronicInvoiceTransactionScope;
  sellerElectronicAddress: ElectronicAddress;
  buyerElectronicAddress: ElectronicAddress | null;
  buyerSiren: string | null;
  deliveryAddress: Readonly<Record<string, unknown>> | null;
};

export function normalizeElectronicAddress(
  input: Readonly<Record<string, unknown>>,
  field: string
): ElectronicAddress {
  const scheme = typeof input.scheme === "string" ? input.scheme.trim().toUpperCase() : "";
  const value = typeof input.value === "string" ? input.value.trim() : "";
  if (!/^[0-9A-Z]{4}$/.test(scheme)) {
    throw new HttpError(
      422,
      "EINVOICE_ELECTRONIC_ADDRESS_INVALID",
      `Le schéma de l'adresse électronique ${field} doit contenir exactement quatre caractères alphanumériques.`
    );
  }
  if (value.length < 1 || value.length > 200 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new HttpError(
      422,
      "EINVOICE_ELECTRONIC_ADDRESS_INVALID",
      `La valeur de l'adresse électronique ${field} est invalide.`
    );
  }
  const directoryEntryId =
    typeof input.directory_entry_id === "string" && input.directory_entry_id.trim()
      ? input.directory_entry_id.trim()
      : typeof input.directoryEntryId === "string" && input.directoryEntryId.trim()
        ? input.directoryEntryId.trim()
        : null;
  if (directoryEntryId !== null && (directoryEntryId.length > 200 || /[\r\n\t]/.test(directoryEntryId))) {
    throw new HttpError(
      422,
      "EINVOICE_DIRECTORY_ENTRY_INVALID",
      `La référence d'annuaire ${field} est invalide.`
    );
  }
  const verifiedRaw = input.verified_at ?? input.verifiedAt;
  let verifiedAt: string | null = null;
  if (typeof verifiedRaw === "string" && verifiedRaw.trim().length > 0) {
    const parsed = new Date(verifiedRaw);
    if (Number.isFinite(parsed.getTime())) verifiedAt = parsed.toISOString();
  }
  if (verifiedAt === null) {
    throw new HttpError(
      422,
      "EINVOICE_DIRECTORY_VERIFICATION_REQUIRED",
      `L'adresse électronique ${field} doit être vérifiée dans l'annuaire avant émission.`
    );
  }
  return { scheme, value, directoryEntryId, verifiedAt };
}

export function buildInvoiceRegulatorySnapshot(params: {
  billingFrameCode: string;
  operationCategory: ElectronicInvoiceOperationCategory;
  transactionScope: ElectronicInvoiceTransactionScope;
  sellerElectronicAddress: Readonly<Record<string, unknown>>;
  buyerElectronicAddress: Readonly<Record<string, unknown>>;
  buyerSiren: string;
  deliveryAddress: Readonly<Record<string, unknown>> | null;
}): InvoiceRegulatorySnapshot {
  const billingFrame = EINVOICE_BILLING_FRAMES[
    params.billingFrameCode as ElectronicInvoiceBillingFrameCode
  ];
  if (!billingFrame) {
    throw new HttpError(
      422,
      "EINVOICE_BILLING_FRAME_INVALID",
      "Le cadre de facturation BT-23 n'appartient pas au catalogue DGFiP/AFNOR qualifié."
    );
  }
  if (billingFrame.operationCategory !== params.operationCategory) {
    throw new HttpError(
      422,
      "EINVOICE_OPERATION_CATEGORY_MISMATCH",
      "La catégorie d'opération ne correspond pas au cadre de facturation BT-23 sélectionné."
    );
  }
  const frenchRoutingRequired =
    params.transactionScope === "FR_PRIVATE_B2B" || params.transactionScope === "FR_PUBLIC";
  const rawBuyerSiren = params.buyerSiren.replace(/\s/g, "");
  const buyerSiren = rawBuyerSiren.length > 0 ? rawBuyerSiren : null;
  if (frenchRoutingRequired && (buyerSiren === null || !/^\d{9}$/.test(buyerSiren))) {
    throw new HttpError(
      422,
      "EINVOICE_BUYER_SIREN_REQUIRED",
      "Le SIREN du client doit être qualifié avant l'émission électronique."
    );
  }
  if (buyerSiren !== null && !/^\d{9}$/.test(buyerSiren)) {
    throw new HttpError(
      422,
      "EINVOICE_BUYER_SIREN_INVALID",
      "Le SIREN client renseigné doit contenir exactement neuf chiffres."
    );
  }
  const hasBuyerElectronicAddress =
    (typeof params.buyerElectronicAddress.scheme === "string"
      && params.buyerElectronicAddress.scheme.trim().length > 0)
    || (typeof params.buyerElectronicAddress.value === "string"
      && params.buyerElectronicAddress.value.trim().length > 0);
  if (frenchRoutingRequired && !hasBuyerElectronicAddress) {
    throw new HttpError(
      422,
      "EINVOICE_BUYER_ROUTING_REQUIRED",
      "L'adresse électronique du client doit être qualifiée pour un flux français."
    );
  }
  return {
    specVersion: DGFiP_EINVOICE_SPEC_VERSION,
    billingFrameCatalogVersion: EINVOICE_BILLING_FRAME_CATALOG_VERSION,
    billingFrameCode: params.billingFrameCode as ElectronicInvoiceBillingFrameCode,
    operationCategory: params.operationCategory,
    transactionScope: params.transactionScope,
    sellerElectronicAddress: normalizeElectronicAddress(
      params.sellerElectronicAddress,
      "vendeur"
    ),
    buyerElectronicAddress: hasBuyerElectronicAddress
      ? normalizeElectronicAddress(params.buyerElectronicAddress, "acheteur")
      : null,
    buyerSiren,
    deliveryAddress: params.deliveryAddress,
  };
}

export function parseInvoiceRegulatorySnapshot(value: unknown): InvoiceRegulatorySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(
      422,
      "EINVOICE_REGULATORY_SNAPSHOT_MISSING",
      "La facture historique ne contient pas d'instantané réglementaire électronique. Qualifiez-la explicitement avant transmission."
    );
  }
  const record = value as Record<string, unknown>;
  return buildInvoiceRegulatorySnapshot({
    billingFrameCode: String(record.billingFrameCode ?? ""),
    operationCategory: String(record.operationCategory ?? "") as ElectronicInvoiceOperationCategory,
    transactionScope: String(record.transactionScope ?? "") as ElectronicInvoiceTransactionScope,
    sellerElectronicAddress:
      record.sellerElectronicAddress && typeof record.sellerElectronicAddress === "object"
        ? (record.sellerElectronicAddress as Record<string, unknown>)
        : {},
    buyerElectronicAddress:
      record.buyerElectronicAddress && typeof record.buyerElectronicAddress === "object"
        ? (record.buyerElectronicAddress as Record<string, unknown>)
        : {},
    buyerSiren: String(record.buyerSiren ?? ""),
    deliveryAddress:
      record.deliveryAddress && typeof record.deliveryAddress === "object" && !Array.isArray(record.deliveryAddress)
        ? (record.deliveryAddress as Record<string, unknown>)
        : null,
  });
}
