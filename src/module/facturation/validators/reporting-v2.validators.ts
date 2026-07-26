// Reporting commercial 360 (#275) — validation des requêtes.
//
// Un filtre n'est accepté que s'il est réellement appliqué par le serveur : pas de
// paramètre décoratif que l'interface pourrait afficher sans effet.

import { z } from "zod";

import {
  COMPARISON_MODES,
  DATE_BASES,
  GRANULARITIES,
  PERIOD_PRESETS,
} from "../domain/reporting-policy";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format AAAA-MM-JJ")
  .refine((value) => {
    const [y, m, d] = value.split("-").map((v) => Number.parseInt(v, 10));
    const probe = new Date(Date.UTC(y, m - 1, d));
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
  }, "Date inexistante");

const trimmed = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .transform((value) => value);

/** Devise : trois lettres majuscules, jamais interpolée dans le SQL. */
const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Code devise ISO 4217 attendu (3 lettres)");

export const reportingFiltersSchema = z.object({
  period: z.enum(PERIOD_PRESETS).optional().default("current_month"),
  from: isoDate.optional(),
  to: isoDate.optional(),
  compare: z.enum(COMPARISON_MODES).optional().default("previous_period"),
  as_of: isoDate.optional(),
  date_basis: z.enum(DATE_BASES).optional().default("document_date"),
  granularity: z.enum(GRANULARITIES).optional().default("month"),

  client_id: trimmed(64).optional(),
  currency: currencyCode.optional(),
  order_type: z.enum(["FERME", "CADRE", "INTERNE"]).optional(),
  commercial_id: z.coerce.number().int().positive().optional(),
  affaire_id: z.coerce.number().int().positive().optional(),
  famille: trimmed(120).optional(),

  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
});

export type ReportingFiltersDTO = z.infer<typeof reportingFiltersSchema>;

export const DRILLDOWN_ENTITIES = [
  "quotes",
  "orders",
  "order_lines",
  "deliveries",
  "invoices",
  "credit_notes",
  "payments",
  "clients",
] as const;
export type DrilldownEntity = (typeof DRILLDOWN_ENTITIES)[number];

export const DRILLDOWN_SCOPES = [
  "all",
  "open",
  "decided",
  "won",
  "lost",
  "expired",
  "backlog",
  "overdue",
  "late",
  "shipped",
  "delivered",
  "outstanding",
  "credit_balance",
  "unallocated",
] as const;
export type DrilldownScope = (typeof DRILLDOWN_SCOPES)[number];

export const drilldownQuerySchema = reportingFiltersSchema.extend({
  entity: z.enum(DRILLDOWN_ENTITIES),
  scope: z.enum(DRILLDOWN_SCOPES).optional().default("all"),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export type DrilldownQueryDTO = z.infer<typeof drilldownQuerySchema>;

export const EXPORT_SECTIONS = [
  "overview",
  "quotes",
  "orders",
  "deliveries",
  "invoicing",
  "receivables",
  "clients",
] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];

export const exportQuerySchema = reportingFiltersSchema.extend({
  section: z.enum(EXPORT_SECTIONS),
  format: z.enum(["csv"]).optional().default("csv"),
  /**
   * Les exports sont anonymisés par défaut : ni e-mail, ni téléphone, ni adresse, ni
   * contact. `include_client_contacts` reste refusé (aucune valeur acceptée) tant
   * qu'aucune base légale n'est documentée — le paramètre existe pour rendre le refus
   * explicite plutôt que silencieux.
   */
  include_client_contacts: z
    .preprocess((value) => (value === undefined ? false : value), z.literal(false, {
      errorMap: () => ({
        message:
          "Les coordonnées client ne sont jamais exportées (RGPD, minimisation). Demande à instruire hors reporting.",
      }),
    }))
    .optional()
    .default(false),
});

export type ExportQueryDTO = z.infer<typeof exportQuerySchema>;
