// Reporting commercial 360 (#275) — politique de périmètre.
//
// Ce module est la SEULE source de vérité pour :
//   - le vocabulaire de statut réellement présent en base (canonique #227 + héritage minuscule) ;
//   - la date de référence de chaque pièce (date d'entrée au registre) ;
//   - les bornes de période et la date d'arrêté, exprimées en Europe/Paris ;
//   - le refus par défaut des capacités de reporting.
//
// Règle cardinale : un indicateur historique à `as_of` ne doit dépendre d'AUCUN
// mouvement postérieur à `as_of`. Le défaut corrigé par #275 venait de là.

import { HttpError } from "../../../utils/httpError";

export const REPORTING_TIMEZONE = "Europe/Paris" as const;

// ---------------------------------------------------------------------------
// Vocabulaire de statut
// ---------------------------------------------------------------------------

/**
 * Statuts de facture qui font entrer la pièce au registre commercial.
 * Canoniques #227 + héritage minuscule encore présent en base (cf. le trigger
 * `fn_protect_facturation_immutable_227`, qui protège exactement cette liste).
 */
export const FACTURE_LEDGER_STATUSES = [
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  // héritage
  "emise",
  "emis",
  "envoyee",
  "partielle",
  "payee",
] as const;

/** Statuts de facture explicitement hors registre (jamais comptés, jamais « zéro implicite »). */
export const FACTURE_EXCLUDED_STATUSES = [
  "DRAFT",
  "PENDING_VALIDATION",
  "APPROVED",
  "CANCELLED",
  // héritage
  "brouillon",
  "annulee",
  "annule",
] as const;

/** Statuts de facture annulés — suivis à part pour la qualité de données. */
export const FACTURE_CANCELLED_STATUSES = ["CANCELLED", "annulee", "annule"] as const;

/** Statuts de facture en préparation (pipeline de facturation, hors facturé net). */
export const FACTURE_DRAFT_STATUSES = [
  "DRAFT",
  "PENDING_VALIDATION",
  "APPROVED",
  "brouillon",
] as const;

/** Statuts d'avoir finalisés : seuls ceux-ci diminuent le facturé net. */
export const AVOIR_LEDGER_STATUSES = ["ISSUED", "emis", "emise", "envoyee"] as const;

export const AVOIR_EXCLUDED_STATUSES = [
  "DRAFT",
  "PENDING_VALIDATION",
  "APPROVED",
  "CANCELLED",
  "brouillon",
  "annule",
  "annulee",
] as const;

/** `devis.statut` — contraint en base par `devis_statut_check`. */
export const DEVIS_STATUSES = [
  "BROUILLON",
  "ENVOYE",
  "ACCEPTE",
  "REFUSE",
  "EXPIRE",
  "ANNULE",
] as const;
export type DevisStatus = (typeof DEVIS_STATUSES)[number];

/** Devis sortis du portefeuille avec une décision explicite. */
export const DEVIS_DECIDED_STATUSES = ["ACCEPTE", "REFUSE"] as const;
/** Devis encore susceptibles d'être gagnés. */
export const DEVIS_OPEN_STATUSES = ["ENVOYE"] as const;

/** `bon_livraison.statut` — contraint en base par `bon_livraison_statut_check`. */
export const BL_STATUSES = ["DRAFT", "READY", "SHIPPED", "DELIVERED", "CANCELLED"] as const;
export type BonLivraisonStatus = (typeof BL_STATUSES)[number];

/** Un BL compte comme sorti quand il est expédié ou livré (cohérent avec `v_bon_livraison_reliquats_226`). */
export const BL_SHIPPED_STATUSES = ["SHIPPED", "DELIVERED"] as const;
export const BL_DELIVERED_STATUSES = ["DELIVERED"] as const;

/**
 * Un règlement compte comme encaissement net si et seulement s'il n'est ni rejeté,
 * ni extourné, ni lui-même une extourne. Cette règle est neutre quelle que soit la
 * convention retenue plus tard pour l'extourne (flag sur l'original ou contre-écriture) :
 * dans les deux cas le net reste juste. Aucune extourne n'existe encore en base.
 */
export const PAIEMENT_EXCLUDED_STATUSES = ["REJECTED", "REVERSED"] as const;

// ---------------------------------------------------------------------------
// Dates, fuseau, périodes
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Date du jour en Europe/Paris.
 * `new Date().toISOString().slice(0,10)` est faux : entre 00:00 et 02:00 heure
 * française il renvoie la veille (UTC). `Intl` avec `timeZone` ne peut pas dériver.
 */
export function todayInParis(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORTING_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts;
}

export function assertIsoDate(value: string, label: string): string {
  if (!ISO_DATE.test(value)) {
    throw new HttpError(400, "REPORTING_DATE_INVALID", `${label} doit être au format AAAA-MM-JJ.`);
  }
  const [y, m, d] = value.split("-").map((v) => Number.parseInt(v, 10));
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new HttpError(400, "REPORTING_DATE_INVALID", `${label} n'est pas une date réelle.`);
  }
  return value;
}

/** Arithmétique de dates calendaires, sans fuseau ni heure d'été (les dates sont des dates). */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map((v) => Number.parseInt(v, 10));
  const probe = new Date(Date.UTC(y, m - 1, d));
  probe.setUTCDate(probe.getUTCDate() + days);
  return probe.toISOString().slice(0, 10);
}

export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map((v) => Number.parseInt(v, 10));
  const targetMonth = m - 1 + months;
  const targetYear = y + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${String(targetYear).padStart(4, "0")}-${String(normalizedMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function startOfMonth(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

export function endOfMonth(isoDate: string): string {
  const [y, m] = isoDate.split("-").map((v) => Number.parseInt(v, 10));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${isoDate.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

export function startOfYear(isoDate: string): string {
  return `${isoDate.slice(0, 4)}-01-01`;
}

export function endOfYear(isoDate: string): string {
  return `${isoDate.slice(0, 4)}-12-31`;
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export const PERIOD_PRESETS = [
  "current_month",
  "last_month",
  "current_quarter",
  "current_year",
  "last_year",
  "last_30_days",
  "last_90_days",
  "last_12_months",
  "custom",
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const COMPARISON_MODES = ["none", "previous_period", "previous_year"] as const;
export type ComparisonMode = (typeof COMPARISON_MODES)[number];

export type Period = { from: string; to: string };

/**
 * Bornes INCLUSIVES des deux côtés (`from <= d <= to`). C'est la convention retenue
 * partout : elle rend la somme des sous-périodes égale au total, ce qui est testé.
 */
export function resolvePeriod(params: {
  preset: PeriodPreset;
  from?: string;
  to?: string;
  today: string;
}): Period {
  const { preset, today } = params;
  switch (preset) {
    case "current_month":
      return { from: startOfMonth(today), to: endOfMonth(today) };
    case "last_month": {
      const anchor = addMonths(startOfMonth(today), -1);
      return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
    }
    case "current_quarter": {
      const month = Number.parseInt(today.slice(5, 7), 10);
      const firstMonth = Math.floor((month - 1) / 3) * 3 + 1;
      const from = `${today.slice(0, 4)}-${String(firstMonth).padStart(2, "0")}-01`;
      return { from, to: endOfMonth(addMonths(from, 2)) };
    }
    case "current_year":
      return { from: startOfYear(today), to: endOfYear(today) };
    case "last_year": {
      const previous = `${Number.parseInt(today.slice(0, 4), 10) - 1}-01-01`;
      return { from: startOfYear(previous), to: endOfYear(previous) };
    }
    case "last_30_days":
      return { from: addDays(today, -29), to: today };
    case "last_90_days":
      return { from: addDays(today, -89), to: today };
    case "last_12_months":
      return { from: startOfMonth(addMonths(today, -11)), to: endOfMonth(today) };
    case "custom": {
      const from = params.from ?? startOfMonth(today);
      const to = params.to ?? today;
      if (from > to) {
        throw new HttpError(
          400,
          "REPORTING_PERIOD_INVALID",
          "La date de début doit précéder la date de fin."
        );
      }
      return { from, to };
    }
    default:
      return { from: startOfMonth(today), to: endOfMonth(today) };
  }
}

/** Vrai si la période couvre des mois calendaires entiers (1er au dernier jour). */
export function isWholeMonthSpan(period: Period): boolean {
  return period.from === startOfMonth(period.from) && period.to === endOfMonth(period.to);
}

function monthsSpan(period: Period): number {
  const fromYear = Number.parseInt(period.from.slice(0, 4), 10);
  const fromMonth = Number.parseInt(period.from.slice(5, 7), 10);
  const toYear = Number.parseInt(period.to.slice(0, 4), 10);
  const toMonth = Number.parseInt(period.to.slice(5, 7), 10);
  return (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1;
}

/**
 * Période comparative.
 *
 * - `previous_year` recule d'un an calendaire.
 * - `previous_period` recule d'un bloc de même nature : mois calendaires entiers pour
 *   une période alignée sur des mois (juillet se compare à juin, pas au 31 mai–30 juin),
 *   sinon décalage d'exactement autant de jours que la période demandée.
 *
 * Dans tous les cas les deux fenêtres sont disjointes et de même durée métier.
 */
export function resolveComparison(period: Period, mode: ComparisonMode): Period | null {
  if (mode === "none") return null;
  if (mode === "previous_year") {
    return { from: addMonths(period.from, -12), to: addMonths(period.to, -12) };
  }
  if (isWholeMonthSpan(period)) {
    const span = monthsSpan(period);
    return {
      from: addMonths(period.from, -span),
      to: endOfMonth(addMonths(period.from, -1)),
    };
  }
  const span = daysBetween(period.from, period.to) + 1;
  return { from: addDays(period.from, -span), to: addDays(period.to, -span) };
}

export const GRANULARITIES = ["day", "week", "month", "quarter", "year"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export function truncExpression(granularity: Granularity, column: string): string {
  switch (granularity) {
    case "day":
      return `${column}::date`;
    case "week":
      return `date_trunc('week', ${column})::date`;
    case "quarter":
      return `date_trunc('quarter', ${column})::date`;
    case "year":
      return `date_trunc('year', ${column})::date`;
    case "month":
    default:
      return `date_trunc('month', ${column})::date`;
  }
}

/**
 * Nombre de compartiments qu'une période produira. Sert à refuser en amont une
 * requête qui produirait des milliers de points (borne explicite, jamais silencieuse).
 */
export function estimateBucketCount(period: Period, granularity: Granularity): number {
  const days = daysBetween(period.from, period.to) + 1;
  switch (granularity) {
    case "day":
      return days;
    case "week":
      return Math.ceil(days / 7) + 1;
    case "month":
      return Math.ceil(days / 28) + 1;
    case "quarter":
      return Math.ceil(days / 89) + 1;
    case "year":
      return Math.ceil(days / 365) + 1;
    default:
      return days;
  }
}

export const MAX_BUCKETS = 400;

// ---------------------------------------------------------------------------
// Base de date (quelle date fait entrer une pièce dans la période)
// ---------------------------------------------------------------------------

export const DATE_BASES = ["document_date", "issue_date"] as const;
export type DateBasis = (typeof DATE_BASES)[number];

/**
 * Expression SQL de la date d'entrée au registre d'une facture ou d'un avoir.
 *
 * - `document_date` : `date_emission`, la date portée par la pièce (défaut, c'est
 *   la date légale du document et la seule disponible sur l'historique).
 * - `issue_date`    : l'horodatage d'émission #227 converti en date Europe/Paris,
 *   avec repli sur `date_emission` quand la pièce est antérieure au workflow.
 */
export function ledgerDateExpression(alias: string, basis: DateBasis): string {
  if (basis === "issue_date") {
    return `COALESCE((${alias}.issued_at AT TIME ZONE '${REPORTING_TIMEZONE}')::date, ${alias}.date_emission)`;
  }
  return `${alias}.date_emission`;
}

// ---------------------------------------------------------------------------
// Devises
// ---------------------------------------------------------------------------

/**
 * Aucune table de taux de change datés n'existe dans le CERP. Additionner deux
 * devises serait une invention. Les agrégats sont donc partitionnés par devise et
 * l'API refuse de produire un total global dès qu'il y a plus d'une devise.
 */
export const DEFAULT_CURRENCY = "EUR";

export type CurrencyCoverage = {
  currencies: string[];
  mixed: boolean;
  reporting_currency: string | null;
};

export function summarizeCurrencies(rows: Array<{ currency?: string | null }>): CurrencyCoverage {
  const set = new Set<string>();
  for (const row of rows) {
    const value = (row.currency ?? "").trim().toUpperCase();
    if (value) set.add(value);
  }
  const currencies = [...set].sort();
  if (currencies.length === 0) {
    return { currencies: [], mixed: false, reporting_currency: null };
  }
  return {
    currencies,
    mixed: currencies.length > 1,
    reporting_currency: currencies.length === 1 ? currencies[0] : null,
  };
}

// ---------------------------------------------------------------------------
// Capacités
// ---------------------------------------------------------------------------

/**
 * Capacités de reporting. `reporting_read` existe déjà (#227) et reste la porte
 * d'entrée ; les trois autres sont ajoutées par #275 dans `finance-policy.ts`.
 */
export const REPORTING_CAPABILITIES = [
  "reporting_read",
  "reporting_financial",
  "reporting_client_detail",
  "reporting_export",
] as const;
export type ReportingCapability = (typeof REPORTING_CAPABILITIES)[number];

// ---------------------------------------------------------------------------
// Marge : indisponible et assumé comme tel
// ---------------------------------------------------------------------------

/**
 * Le moteur de marge objet publie des perspectives traçables, mais le reporting
 * client ne dispose pas encore d'une allocation exhaustive et réconciliée des
 * avoirs, retours, frais indirects et objets multi-clients. Agréger partiellement
 * ces objets fabriquerait un total trompeur ; l'API reste donc indisponible.
 */
export const MARGIN_UNAVAILABLE = {
  available: false,
  reason_code: "CROSS_OBJECT_MARGIN_AGGREGATION_NOT_VALIDATED",
  message:
    "Marge client indisponible — l'allocation exhaustive des objets de marge, retours, avoirs et frais indirects n'est pas encore réconciliée.",
  missing_inputs: [
    "allocation_objet_vers_client",
    "allocation_frais_indirects",
    "traitement_retours_et_avoirs",
    "reconciliation_facture_objet_marge",
  ],
} as const;
