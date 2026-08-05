import crypto from "node:crypto";

import { HttpError } from "../../../utils/httpError";

export const REMINDER_PLACEHOLDERS = [
  "client_name",
  "invoice_number",
  "due_date",
  "outstanding_amount",
  "currency",
  "days_overdue",
] as const;

export type ReminderPlaceholder = (typeof REMINDER_PLACEHOLDERS)[number];

export type ReminderTemplateContext = Record<ReminderPlaceholder, string>;

export type ReminderFailure = {
  code: string;
  retryable: boolean;
  safeMessage: string;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TEMPLATE_TOKEN = /{{\s*([a-z_]+)\s*}}/g;

export function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone }).format(new Date(0));
  } catch {
    throw new HttpError(400, "REMINDER_TIMEZONE_INVALID", "Le fuseau horaire de la politique est invalide.");
  }
}
export function dateInTimeZone(now: Date, timeZone: string): string {
  assertValidTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function dateOnlyToUtc(value: string): number {
  if (!DATE_ONLY.test(value)) {
    throw new HttpError(500, "REMINDER_DATE_INVALID", "Une date métier de relance est invalide.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(timestamp).toISOString().slice(0, 10);
  if (roundTrip !== value) {
    throw new HttpError(500, "REMINDER_DATE_INVALID", "Une date métier de relance est invalide.");
  }
  return timestamp;
}

export function daysBetweenDateOnly(later: string, earlier: string): number {
  return Math.floor((dateOnlyToUtc(later) - dateOnlyToUtc(earlier)) / 86_400_000);
}

export function normalizeCadenceDays(values: readonly number[]): number[] {
  const normalized = [...new Set(values)].sort((left, right) => left - right);
  if (
    normalized.length === 0 ||
    normalized.length > 12 ||
    normalized.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 365)
  ) {
    throw new HttpError(
      400,
      "REMINDER_CADENCE_INVALID",
      "La cadence doit contenir entre 1 et 12 jalons uniques compris entre J+0 et J+365."
    );
  }
  return normalized;
}

export function dueCadenceSteps(cadenceDays: readonly number[], daysOverdue: number): number[] {
  if (!Number.isSafeInteger(daysOverdue)) return [];
  return normalizeCadenceDays(cadenceDays).filter((step) => step <= daysOverdue);
}

export function assertTemplateIsSafe(subject: string, body: string): void {
  if (!subject.trim() || subject.length > 200 || !body.trim() || body.length > 4_000) {
    throw new HttpError(
      400,
      "REMINDER_TEMPLATE_INVALID",
      "Le sujet et le corps du modèle sont requis et doivent respecter les longueurs autorisées."
    );
  }
  const allowed = new Set<string>(REMINDER_PLACEHOLDERS);
  for (const value of [subject, body]) {
    for (const match of value.matchAll(TEMPLATE_TOKEN)) {
      if (!allowed.has(match[1])) {
        throw new HttpError(
          400,
          "REMINDER_TEMPLATE_TOKEN_INVALID",
          `La variable de modèle '{{${match[1]}}}' n'est pas autorisée.`
        );
      }
    }
    if (/{{|}}/.test(value.replace(TEMPLATE_TOKEN, ""))) {
      throw new HttpError(400, "REMINDER_TEMPLATE_INVALID", "Le modèle contient une variable mal formée.");
    }
  }
}

export function renderReminderTemplate(template: string, context: ReminderTemplateContext): string {
  return template.replace(TEMPLATE_TOKEN, (_token, key: ReminderPlaceholder) => context[key]);
}

export function reminderSuggestionKey(invoiceId: number, cadenceStepDays: number): string {
  return crypto
    .createHash("sha256")
    .update(`adv-reminder:v1:invoice:${invoiceId}:cadence:${cadenceStepDays}`)
    .digest("hex");
}

export function requestHash(command: string, payload: unknown): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)])
      );
    }
    return value;
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize({ command, payload })))
    .digest("hex");
}

export function retryDelayMinutes(
  retryDelaysMinutes: readonly number[],
  completedAttemptCount: number
): number | null {
  if (!Number.isSafeInteger(completedAttemptCount) || completedAttemptCount < 1) return null;
  const value = retryDelaysMinutes[completedAttemptCount - 1];
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function safeReminderFailure(error: unknown): ReminderFailure {
  const candidate = error as { code?: unknown; retryable?: unknown; safeMessage?: unknown } | null;
  return {
    code:
      typeof candidate?.code === "string" && /^[A-Z0-9_]{2,80}$/.test(candidate.code)
        ? candidate.code
        : "REMINDER_PROVIDER_FAILURE",
    retryable: candidate?.retryable === true,
    safeMessage:
      typeof candidate?.safeMessage === "string" && candidate.safeMessage.trim()
        ? candidate.safeMessage.slice(0, 300)
        : "Le provider de relance a refusé la tentative.",
  };
}

export function assertExplicitPolicyValidation(confirmation: string): void {
  if (confirmation !== "VALIDER_POLITIQUE_RELANCES") {
    throw new HttpError(
      400,
      "REMINDER_POLICY_CONFIRMATION_REQUIRED",
      "La validation explicite de la politique de relances est requise."
    );
  }
}
