import crypto from "node:crypto";

export const PROCUREMENT_CONTRACT_VERSION = "CERP-PROCUREMENT-1.0.0";
export const PROCUREMENT_TIMEZONE = "Europe/Paris";

export const PROCUREMENT_PROMISE_REASON_CODES = [
  "SUPPLIER_ACKNOWLEDGEMENT",
  "SUPPLIER_DELAY",
  "SUPPLIER_ADVANCE",
  "PARTIAL_SHIPMENT",
  "ORDER_CORRECTION",
  "OTHER",
] as const;

export const PROCUREMENT_ANOMALY_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "DISMISSED"] as const;
export const PROCUREMENT_POLICY_SCOPE_TYPES = ["COMPANY", "SUPPLIER", "ARTICLE", "FAMILY"] as const;

export type ProcurementReliability = "ESTIMATED" | "PARTIAL" | "ACTUAL" | "UNAVAILABLE";

export function roundMetric(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function supplierOtdPct(onTimeCommitments: number, dueCommitments: number): number | null {
  if (!Number.isFinite(onTimeCommitments) || !Number.isFinite(dueCommitments)) return null;
  if (onTimeCommitments < 0 || dueCommitments <= 0 || onTimeCommitments > dueCommitments) return null;
  return roundMetric((onTimeCommitments / dueCommitments) * 100, 2);
}

/** Population standard deviation, expressed in calendar days. */
export function leadTimeVariabilityDays(values: readonly number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (finite.length < 2) return null;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
  return roundMetric(Math.sqrt(variance), 2);
}

export function weightedPriceVariancePct(input: {
  orderedAmount: number;
  invoicedAmount: number;
}): number | null {
  if (!Number.isFinite(input.orderedAmount) || !Number.isFinite(input.invoicedAmount)) return null;
  if (input.orderedAmount <= 0 || input.invoicedAmount < 0) return null;
  return roundMetric(((input.invoicedAmount - input.orderedAmount) / input.orderedAmount) * 100, 2);
}

export function rejectionRatePct(rejectedQty: number, inspectedQty: number): number | null {
  if (!Number.isFinite(rejectedQty) || !Number.isFinite(inspectedQty)) return null;
  if (rejectedQty < 0 || inspectedQty <= 0 || rejectedQty > inspectedQty) return null;
  return roundMetric((rejectedQty / inspectedQty) * 100, 2);
}

export function calendarDaysBetween(from: string, to: string): number | null {
  const start = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.floor((end - start) / 86_400_000);
}

export type UnitNormalization =
  | { status: "EXACT" | "CONVERTED"; purchaseQty: number }
  | { status: "UNCONVERTIBLE"; purchaseQty: null };

/**
 * A receipt can contribute only when its unit is the purchase unit, or when the
 * order stores an explicit stock-units-per-purchase-unit coefficient.
 */
export function normalizeReceiptQuantity(input: {
  receiptQty: number;
  receiptUnit: string | null;
  purchaseUnit: string | null;
  stockUnit: string | null;
  stockUnitsPerPurchaseUnit: number | null;
}): UnitNormalization {
  if (!Number.isFinite(input.receiptQty) || input.receiptQty < 0) {
    return { status: "UNCONVERTIBLE", purchaseQty: null };
  }
  const receiptUnit = input.receiptUnit?.trim().toLowerCase() ?? null;
  const purchaseUnit = input.purchaseUnit?.trim().toLowerCase() ?? null;
  const stockUnit = input.stockUnit?.trim().toLowerCase() ?? null;
  if (receiptUnit === purchaseUnit || (receiptUnit === null && purchaseUnit === null)) {
    return { status: "EXACT", purchaseQty: input.receiptQty };
  }
  if (
    receiptUnit !== null &&
    receiptUnit === stockUnit &&
    input.stockUnitsPerPurchaseUnit !== null &&
    Number.isFinite(input.stockUnitsPerPurchaseUnit) &&
    input.stockUnitsPerPurchaseUnit > 0
  ) {
    return {
      status: "CONVERTED",
      purchaseQty: roundMetric(input.receiptQty / input.stockUnitsPerPurchaseUnit, 6),
    };
  }
  return { status: "UNCONVERTIBLE", purchaseQty: null };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
    .join(",")}}`;
}

export function procurementPayloadHash(value: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export function anomalyKey(kind: string, entityId: string): string {
  return `${kind}:${crypto.createHash("sha256").update(entityId, "utf8").digest("hex").slice(0, 24)}`;
}
