import crypto from "node:crypto";

import { divideHalfUp, formatDecimal, moneyToCents } from "../../facturation/domain/decimal-money";

export const ADV_RELIABILITY_CONTRACT_VERSION = "CERP-ADV-1.0.0" as const;
export const ADV_RELIABILITY_TIMEZONE = "Europe/Paris" as const;

export const DELIVERY_BLOCK_CATEGORIES = ["QUALITY", "DOCUMENT", "STOCK", "TRANSPORT"] as const;
export const DELIVERY_BLOCK_STATUSES = ["OPEN", "RESOLVED"] as const;
export const PAYMENT_PROMISE_STATUSES = ["OPEN", "KEPT", "BROKEN", "CANCELLED"] as const;
export const INVOICE_DISPUTE_CATEGORIES = [
  "QUALITY",
  "DOCUMENT",
  "PRICE",
  "QUANTITY",
  "DELIVERY",
  "TAX",
  "OTHER",
] as const;
export const INVOICE_DISPUTE_STATUSES = ["OPEN", "RESOLVED", "CANCELLED"] as const;

export type AdvReliability = "ACTUAL" | "PARTIAL" | "UNAVAILABLE";
export type DeliveryQueueState = "DUE" | "READY" | "BLOCKED" | "LATE" | "PLANNED" | "COMPLETE";

const DAY_MS = 86_400_000;

function day(value: string): number {
  return Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
}

export function calendarAgeDays(from: string | null, asOf: string): number | null {
  if (!from) return null;
  const start = day(from);
  const end = day(asOf);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/**
 * Priority is intentional: a known blocker outranks readiness and lateness, so
 * the work queue always exposes the action that can unlock the promise.
 */
export function classifyDeliveryQueue(input: {
  dueDate: string | null;
  asOf: string;
  remainingQuantity: number;
  ready: boolean;
  blocked: boolean;
}): DeliveryQueueState {
  if (input.remainingQuantity <= 0) return "COMPLETE";
  if (input.blocked) return "BLOCKED";
  if (input.dueDate && input.dueDate < input.asOf) return "LATE";
  if (input.ready) return "READY";
  if (input.dueDate && input.dueDate <= input.asOf) return "DUE";
  return "PLANNED";
}

export function reliabilityFromCoverage(total: number, evidenced: number): AdvReliability {
  if (total <= 0 || evidenced <= 0) return "UNAVAILABLE";
  return evidenced >= total ? "ACTUAL" : "PARTIAL";
}

/**
 * Ratio DSO: encours TTC / chiffre d'affaires TTC émis sur les 365 jours × 365.
 * Inputs are exact decimal strings; arithmetic stays in integer cents.
 */
export function computeDsoDays(openTtc: string, issuedTtc365d: string): string | null {
  const open = moneyToCents(openTtc, "Encours TTC");
  const issued = moneyToCents(issuedTtc365d, "Facturé TTC sur 365 jours");
  if (open < 0n || issued <= 0n) return null;
  const hundredthsOfDay = divideHalfUp(open * 36500n, issued);
  return formatDecimal(hundredthsOfDay, 2);
}

export type CashForecastInvoice = {
  invoiceId: string;
  currency: string;
  balanceTtc: string;
  scheduledWithinHorizonTtc: string;
  promisedWithinHorizonTtc: string;
};

/** A promise consumes the invoice balance first; schedules use only the remainder. */
export function computeCashForecast(invoice: CashForecastInvoice): {
  invoice_id: string;
  currency: string;
  promised_ttc: string;
  scheduled_ttc: string;
  expected_ttc: string;
} {
  const balance = moneyToCents(invoice.balanceTtc, "Solde facture");
  const promised = moneyToCents(invoice.promisedWithinHorizonTtc, "Promesses");
  const scheduled = moneyToCents(invoice.scheduledWithinHorizonTtc, "Échéances");
  const boundedBalance = balance > 0n ? balance : 0n;
  const boundedPromise = promised > 0n ? (promised < boundedBalance ? promised : boundedBalance) : 0n;
  const remaining = boundedBalance - boundedPromise;
  const boundedSchedule = scheduled > 0n ? (scheduled < remaining ? scheduled : remaining) : 0n;
  return {
    invoice_id: invoice.invoiceId,
    currency: invoice.currency,
    promised_ttc: formatDecimal(boundedPromise, 2),
    scheduled_ttc: formatDecimal(boundedSchedule, 2),
    expected_ttc: formatDecimal(boundedPromise + boundedSchedule, 2),
  };
}

export type AgingBucket = "NOT_DUE" | "DUE_0_30" | "DUE_31_60" | "DUE_61_90" | "DUE_91_PLUS" | "UNKNOWN";

export function agingBucket(dueDate: string | null, asOf: string): AgingBucket {
  if (!dueDate) return "UNKNOWN";
  if (dueDate >= asOf) return "NOT_DUE";
  const age = calendarAgeDays(dueDate, asOf);
  if (age === null) return "UNKNOWN";
  if (age <= 30) return "DUE_0_30";
  if (age <= 60) return "DUE_31_60";
  if (age <= 90) return "DUE_61_90";
  return "DUE_91_PLUS";
}

export type EInvoiceReadiness = {
  status: "NOT_ASSESSED" | "BLOCKED" | "READY_FOR_CONNECTOR";
  missing: string[];
  reliability: "PARTIAL";
};

/**
 * Internal completeness only. This deliberately never emits a regulatory
 * transport status (sent/received/accepted/rejected) without a connector.
 */
export function assessEInvoiceReadiness(input: {
  issued: boolean;
  legalNumber: string | null;
  currency: string | null;
  clientId: string | null;
  totalTtc: string | null;
}): EInvoiceReadiness {
  if (!input.issued) return { status: "NOT_ASSESSED", missing: [], reliability: "PARTIAL" };
  const missing: string[] = [];
  if (!input.legalNumber?.trim()) missing.push("LEGAL_NUMBER");
  if (!input.currency?.trim()) missing.push("CURRENCY");
  if (!input.clientId?.trim()) missing.push("CLIENT");
  if (input.totalTtc === null) missing.push("TOTAL_TTC");
  return {
    status: missing.length === 0 ? "READY_FOR_CONNECTOR" : "BLOCKED",
    missing,
    reliability: "PARTIAL",
  };
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

export function advPayloadHash(value: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}
