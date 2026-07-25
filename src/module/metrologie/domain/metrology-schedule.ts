// Échéances métrologiques (#229) — calcul pur, sans I/O.
//
// Règle : une échéance est DÉRIVÉE de la dernière preuve admissible et de la
// version de plan applicable. Elle n'est jamais saisie à la main sans dérogation
// justifiée et approuvée (`ScheduleOverride`), et le frontend ne la calcule
// jamais lui-même.

import { HttpError } from "../../../utils/httpError";

import type { MetrologyEffectiveState, MetrologyEquipmentState } from "./metrology-policy";

export type PeriodicityUnit = "DAY" | "WEEK" | "MONTH" | "YEAR";
export type ScheduleBase = "LAST_PROOF" | "FIXED_DATE";

export type SchedulePlan = {
  periodicite_valeur: number;
  periodicite_unite: PeriodicityUnit;
  base_calcul: ScheduleBase;
  alert_window_days: number;
  effective_from: string | null;
};

export type ScheduleInput = {
  plan: SchedulePlan;
  /** Date de la dernière preuve admissible (verdict conforme ou conforme avec restriction). */
  lastProofDate: string | null;
  /** Échéance imposée par le certificat externe, quand le prestataire en fixe une. */
  certificateDueDate?: string | null;
  /** Repli quand aucune preuve n'existe encore : mise en service ou création. */
  fallbackDate: string | null;
};

/* -------------------------------------------------------------------------- */
/* Utilitaires de date (UTC strict, aucun fuseau implicite)                    */
/* -------------------------------------------------------------------------- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const raw = value.length > 10 ? value.slice(0, 10) : value;
  if (!ISO_DATE.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addPeriod(date: Date, value: number, unit: PeriodicityUnit): Date {
  const next = new Date(date.getTime());
  switch (unit) {
    case "DAY":
      next.setUTCDate(next.getUTCDate() + value);
      return next;
    case "WEEK":
      next.setUTCDate(next.getUTCDate() + value * 7);
      return next;
    case "YEAR":
      return addMonthsClamped(next, value * 12);
    case "MONTH":
    default:
      return addMonthsClamped(next, value);
  }
}

/**
 * Ajout de mois avec bornage du quantième : le 31/01 + 1 mois donne le 28/02
 * (ou 29/02), jamais le 03/03. Une échéance métrologique qui « saute » un mois
 * est un écart d'audit.
 */
function addMonthsClamped(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const anchor = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  anchor.setUTCMonth(anchor.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)
  ).getUTCDate();
  anchor.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return anchor;
}

export function daysBetween(from: Date, to: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/* -------------------------------------------------------------------------- */
/* Calcul d'échéance                                                          */
/* -------------------------------------------------------------------------- */

export type ScheduleResult = {
  next_due_date: string | null;
  /** D'où vient la date : utile pour l'expliquer dans l'UI sans la recalculer. */
  source: "CERTIFICATE" | "LAST_PROOF" | "EFFECTIVE_FROM" | "FALLBACK" | "NONE";
  base_date: string | null;
};

export function computeNextDueDate(input: ScheduleInput): ScheduleResult {
  const { plan } = input;

  // Une échéance imposée par le certificat externe prime : le prestataire est
  // l'autorité sur la validité de SON étalonnage.
  const certificate = parseIsoDate(input.certificateDueDate ?? null);
  if (certificate) {
    return { next_due_date: toIsoDate(certificate), source: "CERTIFICATE", base_date: null };
  }

  if (plan.base_calcul === "FIXED_DATE") {
    const effective = parseIsoDate(plan.effective_from);
    if (!effective) return { next_due_date: null, source: "NONE", base_date: null };
    return {
      next_due_date: toIsoDate(addPeriod(effective, plan.periodicite_valeur, plan.periodicite_unite)),
      source: "EFFECTIVE_FROM",
      base_date: toIsoDate(effective),
    };
  }

  const proof = parseIsoDate(input.lastProofDate);
  if (proof) {
    return {
      next_due_date: toIsoDate(addPeriod(proof, plan.periodicite_valeur, plan.periodicite_unite)),
      source: "LAST_PROOF",
      base_date: toIsoDate(proof),
    };
  }

  const fallback = parseIsoDate(input.fallbackDate);
  if (fallback) {
    return {
      next_due_date: toIsoDate(addPeriod(fallback, plan.periodicite_valeur, plan.periodicite_unite)),
      source: "FALLBACK",
      base_date: toIsoDate(fallback),
    };
  }

  return { next_due_date: null, source: "NONE", base_date: null };
}

/* -------------------------------------------------------------------------- */
/* Dérivation de l'état effectif                                              */
/* -------------------------------------------------------------------------- */

export type DueStatus = "OK" | "DUE_SOON" | "OVERDUE" | "UNKNOWN";

export type DueEvaluation = {
  status: DueStatus;
  next_due_date: string | null;
  days_remaining: number | null;
  days_overdue: number;
};

export function evaluateDue(params: {
  nextDueDate: string | null;
  alertWindowDays: number;
  at: Date;
}): DueEvaluation {
  const due = parseIsoDate(params.nextDueDate);
  if (!due) {
    return { status: "UNKNOWN", next_due_date: null, days_remaining: null, days_overdue: 0 };
  }
  const today = parseIsoDate(toIsoDate(params.at)) as Date;
  const remaining = daysBetween(today, due);
  if (remaining < 0) {
    return {
      status: "OVERDUE",
      next_due_date: toIsoDate(due),
      days_remaining: remaining,
      days_overdue: Math.abs(remaining),
    };
  }
  const window = Number.isFinite(params.alertWindowDays) ? Math.max(0, params.alertWindowDays) : 0;
  return {
    status: remaining <= window ? "DUE_SOON" : "OK",
    next_due_date: toIsoDate(due),
    days_remaining: remaining,
    days_overdue: 0,
  };
}

/**
 * État effectif exposé à l'UI : l'état de gouvernance stocké l'emporte toujours
 * sur le dérivé d'échéance (une quarantaine ne devient pas « bientôt dû »).
 */
export function deriveEffectiveState(params: {
  storedState: MetrologyEquipmentState;
  due: DueEvaluation;
}): MetrologyEffectiveState {
  const stored = params.storedState;
  if (stored !== "ACTIVE" && stored !== "QUALIFIED") return stored;
  if (params.due.status === "OVERDUE") return "OVERDUE";
  if (params.due.status === "DUE_SOON") return "DUE_SOON";
  return stored;
}

/* -------------------------------------------------------------------------- */
/* Dérogation d'échéance                                                      */
/* -------------------------------------------------------------------------- */

export type ScheduleOverride = {
  requestedDueDate: string;
  computedDueDate: string | null;
  reason: string | null;
  approvedByUserId: number | null;
  requestedByUserId: number;
};

/**
 * Repousser une échéance calculée est une dérogation : motif obligatoire,
 * approbateur distinct du demandeur, et jamais au-delà d'un an après le calcul.
 */
export function assertScheduleOverrideAllowed(input: ScheduleOverride): void {
  const requested = parseIsoDate(input.requestedDueDate);
  if (!requested) {
    throw new HttpError(422, "METROLOGY_DUE_DATE_INVALID", "Échéance dérogatoire invalide.");
  }
  if ((input.reason ?? "").trim().length < 20) {
    throw new HttpError(
      422,
      "METROLOGY_DUE_OVERRIDE_JUSTIFICATION_REQUIRED",
      "Repousser une échéance calculée exige une justification d'au moins 20 caractères."
    );
  }
  if (input.approvedByUserId === null) {
    throw new HttpError(
      422,
      "METROLOGY_DUE_OVERRIDE_APPROVAL_REQUIRED",
      "Une échéance dérogatoire exige une approbation explicite."
    );
  }
  if (input.approvedByUserId === input.requestedByUserId) {
    throw new HttpError(
      403,
      "METROLOGY_SEPARATION_OF_DUTIES",
      "Le demandeur ne peut pas approuver sa propre dérogation d'échéance."
    );
  }

  const computed = parseIsoDate(input.computedDueDate);
  if (computed) {
    const drift = daysBetween(computed, requested);
    if (drift > 365) {
      throw new HttpError(
        422,
        "METROLOGY_DUE_OVERRIDE_TOO_FAR",
        "Une échéance dérogatoire ne peut pas dépasser d'un an l'échéance calculée.",
        { computed_due_date: toIsoDate(computed), drift_days: drift }
      );
    }
  }
}
