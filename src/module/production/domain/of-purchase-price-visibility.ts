const PURCHASE_PRICE_FIELDS = [
  "prix", "pu_achat", "prix_par_quantite", "tarif", "tva_achat",
  "forfait_ht", "minimum_facturation_ht", "total_achat_ht", "total_achat_ttc",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function redactOfPurchaseLinePrices(line: unknown) {
  if (!isRecord(line)) return line;
  const projected = { ...line };
  for (const field of PURCHASE_PRICE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(projected, field)) projected[field] = null;
  }
  return projected;
}

function redactPurchaseCollections(value: unknown) {
  if (!isRecord(value)) return value;
  return {
    ...value,
    ...(Array.isArray(value.achats) && { achats: value.achats.map(redactOfPurchaseLinePrices) }),
    ...(Array.isArray(value.purchases) && { purchases: value.purchases.map(redactOfPurchaseLinePrices) }),
  };
}

/** Redact only the HTTP projection. Hashes always identify the stored snapshot. */
export function redactOfTechnicalSnapshotPrices(snapshot: unknown) {
  if (!isRecord(snapshot)) return snapshot;
  return {
    ...redactPurchaseCollections(snapshot) as Record<string, unknown>,
    ...(isRecord(snapshot.preparation_evidence) && {
      preparation_evidence: redactPurchaseCollections(snapshot.preparation_evidence),
    }),
  };
}

export function redactOfPreparationPrices(data: { sources?: unknown; of?: unknown }) {
  return {
    ...data,
    ...(isRecord(data.sources) && { sources: redactPurchaseCollections(data.sources) }),
    ...(isRecord(data.of) && Object.prototype.hasOwnProperty.call(data.of, "technical_snapshot") && {
      of: { ...data.of, technical_snapshot: redactOfTechnicalSnapshotPrices(data.of.technical_snapshot) },
    }),
  };
}
