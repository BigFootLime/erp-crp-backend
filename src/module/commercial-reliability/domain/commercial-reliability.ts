import crypto from "node:crypto";

export const COMMERCIAL_CONTRACT_VERSION = "CERP-COMMERCIAL-1.0.0";
export const COMMERCIAL_TIMEZONE = "Europe/Paris";

export const LOSS_REASON_CODES = [
  "PRICE",
  "LEAD_TIME",
  "TECHNICAL_FIT",
  "COMPETITOR",
  "BUDGET",
  "NO_DECISION",
  "DUPLICATE",
  "CUSTOMER_CANCELLED",
  "OTHER",
] as const;

export const ORDER_CANCELLATION_REASON_CODES = [
  "CUSTOMER_CANCELLED",
  "DUPLICATE",
  "COMMERCIAL_ERROR",
  "TECHNICAL_IMPOSSIBILITY",
  "OTHER",
] as const;

export const REMINDER_CHANNELS = ["EMAIL", "PHONE", "MEETING", "OTHER"] as const;

export type CommercialReliability = "ESTIMATED" | "PARTIAL" | "ACTUAL";
export type CommercialRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type CommercialRiskInput = {
  clientBlocked: boolean;
  overdueReceivablesTtc: number;
  overdueBacklogHt: number;
  blockedOrders: number;
  expiredOpenQuotes: number;
  missingFinancialPermission?: boolean;
};

export type CommercialRisk = {
  level: CommercialRiskLevel;
  factors: string[];
  reliability: CommercialReliability;
};

/**
 * Risk is deliberately categorical: no unsupported probability is fabricated.
 * Each escalation is backed by an observable source fact.
 */
export function qualifyCommercialRisk(input: CommercialRiskInput): CommercialRisk {
  const factors: string[] = [];
  if (input.clientBlocked) factors.push("CLIENT_BLOCKED");
  if (input.overdueReceivablesTtc > 0) factors.push("OVERDUE_RECEIVABLES");
  if (input.blockedOrders > 0) factors.push("BLOCKED_ORDERS");
  if (input.overdueBacklogHt > 0) factors.push("OVERDUE_BACKLOG");
  if (input.expiredOpenQuotes > 0) factors.push("EXPIRED_OPEN_QUOTES");
  if (input.missingFinancialPermission) factors.push("FINANCIAL_SCOPE_HIDDEN");

  let level: CommercialRiskLevel = "LOW";
  if (input.clientBlocked) level = "CRITICAL";
  else if (input.overdueReceivablesTtc > 0 || input.blockedOrders > 0) level = "HIGH";
  else if (input.overdueBacklogHt > 0 || input.expiredOpenQuotes > 0) level = "MEDIUM";

  return {
    level,
    factors,
    reliability: input.missingFinancialPermission ? "PARTIAL" : "ACTUAL",
  };
}

export type AgingBucket = "NOT_DUE" | "1_30" | "31_60" | "61_90" | "90_PLUS" | "UNDATED";

export function orderAgingBucket(dueDate: string | null, asOf: string): AgingBucket {
  if (dueDate === null) return "UNDATED";
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const cut = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(due) || !Number.isFinite(cut)) return "UNDATED";
  const days = Math.floor((cut - due) / 86_400_000);
  if (days <= 0) return "NOT_DUE";
  if (days <= 30) return "1_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "90_PLUS";
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

export function commercialPayloadHash(value: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 8) {
    throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  }
  return value.trim().slice(0, 120);
}

export function effectiveDiscountPct(input: {
  grossAmountHt: number;
  netAmountHt: number;
}): number | null {
  if (!Number.isFinite(input.grossAmountHt) || !Number.isFinite(input.netAmountHt) || input.grossAmountHt < 0) {
    return null;
  }
  if (input.grossAmountHt === 0) return input.netAmountHt === 0 ? 0 : null;
  return Math.round(((input.grossAmountHt - input.netAmountHt) / input.grossAmountHt) * 1_000_000) / 10_000;
}

export function conversionRate(won: number, decided: number): number | null {
  if (!Number.isFinite(won) || !Number.isFinite(decided) || won < 0 || decided <= 0) return null;
  return Math.round((won / decided) * 1_000_000) / 10_000;
}
