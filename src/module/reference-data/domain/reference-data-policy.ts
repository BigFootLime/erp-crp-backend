import crypto from "node:crypto";

import { effectiveRoleParts } from "../../auth/domain/roles";
import { HttpError } from "../../../utils/httpError";
import type {
  ReferenceDataCapabilities,
  ReferenceDatasetCode,
  WritableReferenceDatasetCode,
} from "../types/reference-data.types";

export type ReferenceDataCapability = keyof ReferenceDataCapabilities;

export const REFERENCE_DATASETS: ReadonlyArray<{
  code: ReferenceDatasetCode;
  domain: string;
  label: string;
  owner: string;
  criticality: "CRITICAL" | "HIGH";
  definition: string;
  unit: string;
  canonical_source: string;
  action_path: string;
  affected_modules: string[];
  change_mode: "GOVERNED" | "SPECIALIZED_WORKFLOW";
}> = [
  {
    code: "HOURLY_RATES", domain: "Coûts", label: "Taux horaires", owner: "Méthodes / Direction",
    criticality: "CRITICAL", definition: "Taux horaire applicable par centre de frais.", unit: "EUR/heure",
    canonical_source: "public.production_cost_center_rates", action_path: "/methodes/centres-frais",
    affected_modules: ["Méthodes", "Devis", "Marges", "Production"], change_mode: "GOVERNED",
  },
  {
    code: "PRODUCTION_CALENDARS", domain: "Capacité", label: "Calendriers de production", owner: "Planification",
    criticality: "CRITICAL", definition: "Jours et plages ouvrés utilisés par la capacité et le planning.", unit: "minutes ouvrées/jour",
    canonical_source: "public.programmation_calendars", action_path: "/planning/parametres/calendriers",
    affected_modules: ["Planning", "Production", "Délais"], change_mode: "GOVERNED",
  },
  {
    code: "MATERIAL_COSTS", domain: "Achats", label: "Coûts matière", owner: "Achats / Contrôle de gestion",
    criticality: "CRITICAL", definition: "Prix unitaire fournisseur daté servant aux propositions et coûts matière.", unit: "devise/unité d'achat",
    canonical_source: "public.fournisseur_catalogue + fournisseur_catalogue_prix_history", action_path: "/fournisseurs",
    affected_modules: ["Achats", "Devis", "Marges", "Réapprovisionnement"], change_mode: "GOVERNED",
  },
  {
    code: "UNIT_CONVERSIONS", domain: "Stock", label: "Unités et conversions", owner: "Méthodes / Magasin",
    criticality: "CRITICAL", definition: "Conversion explicite entre unité d'achat et unité de stock.", unit: "unité stock/unité achat",
    canonical_source: "public.units + public.fournisseur_catalogue", action_path: "/stock/articles",
    affected_modules: ["Stock", "Achats", "Production", "Réapprovisionnement"], change_mode: "GOVERNED",
  },
  {
    code: "SUPPLIER_LEAD_TIMES", domain: "Achats", label: "Délais fournisseurs", owner: "Achats",
    criticality: "CRITICAL", definition: "Délai fournisseur déclaré utilisé dans les dates de besoin et de rupture.", unit: "jours calendaires",
    canonical_source: "public.fournisseur_catalogue + fournisseur_catalogue_prix_history", action_path: "/fournisseurs",
    affected_modules: ["Achats", "Planning", "Stock", "Réapprovisionnement"], change_mode: "GOVERNED",
  },
  {
    code: "STOCK_VALUATION", domain: "Stock", label: "Règle de valorisation", owner: "Direction / Finance",
    criticality: "CRITICAL", definition: "Méthode de valorisation déclarée pour le stock.", unit: "méthode",
    canonical_source: "public.erp_settings[stock.valuation_method]", action_path: "/administration/reference-data",
    affected_modules: ["Stock", "Marges", "Finance", "Direction"], change_mode: "GOVERNED",
  },
  {
    code: "MARGIN_RATE_CARDS", domain: "Coûts", label: "Cartes de taux de marge", owner: "Contrôle de gestion",
    criticality: "CRITICAL", definition: "Versions des coûts machine, opérateur, contrôle et frais indirects.", unit: "EUR/h, EUR/u ou %",
    canonical_source: "public.margin_rate_versions + public.margin_rates", action_path: "/reporting-commercial",
    affected_modules: ["Devis", "Marges", "Direction"], change_mode: "SPECIALIZED_WORKFLOW",
  },
  {
    code: "STOCK_DECISION_POLICIES", domain: "Stock", label: "Politiques de décision stock", owner: "Responsable stock",
    criticality: "HIGH", definition: "Paramètres datés ABC, dormance, couverture et tolérance d'inventaire.", unit: "jours, semaines et %",
    canonical_source: "public.stock_intelligence_policy_versions", action_path: "/stock/dashboard",
    affected_modules: ["Stock", "Réapprovisionnement", "Direction"], change_mode: "SPECIALIZED_WORKFLOW",
  },
] as const;

export const WRITABLE_REFERENCE_DATASETS = new Set<ReferenceDatasetCode>([
  "HOURLY_RATES", "PRODUCTION_CALENDARS", "MATERIAL_COSTS", "UNIT_CONVERSIONS",
  "SUPPLIER_LEAD_TIMES", "STOCK_VALUATION",
]);

const READ_ROLES = new Set([
  "admin", "administrateur", "administrateursystemeetreseau", "directeur", "direction",
  "method", "methodes", "responsableproduction", "responsableprogrammation", "planning",
  "planification", "achats", "responsableachats", "stock", "responsablestock",
]);
const PROPOSE_ROLES = new Set([
  "admin", "administrateur", "administrateursystemeetreseau", "directeur", "direction",
  "method", "methodes", "responsableproduction", "responsableprogrammation", "planning",
  "planification", "achats", "responsableachats", "responsablestock",
]);
const APPROVE_ROLES = new Set([
  "admin", "administrateur", "administrateursystemeetreseau", "directeur", "direction",
]);

function normalizeRole(value: string): string {
  return value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\s_-]+/g, "");
}

export function roleHasReferenceDataCapability(
  role: string | null | undefined,
  capability: ReferenceDataCapability
): boolean {
  const parts = effectiveRoleParts(role).map(normalizeRole);
  const allowed = capability === "approve" || capability === "apply"
    ? APPROVE_ROLES
    : capability === "propose" || capability === "import"
      ? PROPOSE_ROLES
      : READ_ROLES;
  return parts.some((part) => allowed.has(part));
}

export function referenceDataCapabilitiesFor(role: string | null | undefined): ReferenceDataCapabilities {
  return {
    view: roleHasReferenceDataCapability(role, "view"),
    export: roleHasReferenceDataCapability(role, "export"),
    propose: roleHasReferenceDataCapability(role, "propose"),
    import: roleHasReferenceDataCapability(role, "import"),
    approve: roleHasReferenceDataCapability(role, "approve"),
    apply: roleHasReferenceDataCapability(role, "apply"),
  };
}

export function affectedModulesFor(datasetCode: WritableReferenceDatasetCode): string[] {
  return [...(REFERENCE_DATASETS.find((entry) => entry.code === datasetCode)?.affected_modules ?? [])];
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
    .join(",")}}`;
}

export function referencePayloadHash(value: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export function changedFields(before: Record<string, unknown> | null, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  return [...keys].filter((key) => stableStringify(before?.[key]) !== stableStringify(after[key])).sort();
}

export function assertReferenceEffectiveDateAllowed(effectiveFrom: string, asOf = new Date().toISOString().slice(0, 10)): void {
  if (effectiveFrom < asOf) {
    throw new HttpError(
      422,
      "RETROACTIVE_REFERENCE_CHANGE_FORBIDDEN",
      "Une modification rétroactive doit passer par une correction historique dédiée et ne peut pas être silencieuse."
    );
  }
}

export function assertReferenceSnapshotFresh(expected: string, current: string): void {
  if (expected !== current) {
    throw new HttpError(
      409,
      "REFERENCE_SNAPSHOT_STALE",
      "Une valeur source a changé depuis la comparaison. Rechargez et soumettez une nouvelle proposition."
    );
  }
}
