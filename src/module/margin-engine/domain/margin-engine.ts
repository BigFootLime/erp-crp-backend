import crypto from "node:crypto";

export const MARGIN_FORMULA_VERSION = "CERP-MARGIN-2.0.0" as const;
export const MARGIN_CURRENCY = "EUR" as const;

export const MARGIN_COST_CATEGORIES = [
  "MATERIAL",
  "PURCHASE",
  "SUBCONTRACTING",
  "MACHINE",
  "OPERATOR",
  "CONTROL",
  "TOOLING",
  "PACKAGING",
  "TRANSPORT",
  "SCRAP",
  "REWORK",
  "OVERHEAD",
] as const;
export type MarginCostCategory = (typeof MARGIN_COST_CATEGORIES)[number];
export const MARGIN_BASES = ["QUOTED", "STANDARD", "UPDATED", "ACTUAL"] as const;
export type MarginBasis = (typeof MARGIN_BASES)[number];
export type MarginReliability = "ESTIMATED" | "PARTIAL" | "ACTUAL";
export type MarginSourceReliability = "ESTIMATED" | "DECLARED" | "VERIFIED" | "UNKNOWN";
export type MarginScopeType = "DEVIS_LINE" | "DEVIS" | "AFFAIRE" | "OF";
export type MarginInputAvailability = "PROVIDED" | "NOT_APPLICABLE";
export type MarginRateUnit = "EUR_PER_HOUR" | "EUR_PER_UNIT" | "PERCENT_OF_DIRECT_COST";

const SCALE_DIGITS = 6;
const SCALE = 1_000_000n;

function pow10(digits: number): bigint {
  return 10n ** BigInt(digits);
}

/** Decimal parser with half-away-from-zero rounding to six internal decimals. */
export function decimal(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value * SCALE;
  const text = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`Invalid decimal: ${text}`);
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = match[3] ?? "";
  const kept = (fraction.slice(0, SCALE_DIGITS) + "0".repeat(SCALE_DIGITS)).slice(0, SCALE_DIGITS);
  let scaled = whole * SCALE + BigInt(kept);
  const next = fraction[SCALE_DIGITS];
  if (next && next >= "5") scaled += 1n;
  return sign * scaled;
}

function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Division by zero");
  const negative = (numerator < 0n) !== (denominator < 0n);
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const quotient = a / b;
  const remainder = a % b;
  const rounded = remainder * 2n >= b ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

function multiply(left: bigint, right: bigint): bigint {
  return roundDiv(left * right, SCALE);
}

function format(value: bigint, digits: number): string {
  const factor = pow10(SCALE_DIGITS - digits);
  const rounded = roundDiv(value, factor);
  const negative = rounded < 0n;
  const absolute = negative ? -rounded : rounded;
  const unit = pow10(digits);
  const whole = absolute / unit;
  const fraction = (absolute % unit).toString().padStart(digits, "0");
  return `${negative ? "-" : ""}${whole}${digits > 0 ? `.${fraction}` : ""}`;
}

export function money(value: bigint): string {
  return format(value, 2);
}

function percentage(numerator: bigint, denominator: bigint): string | null {
  if (denominator === 0n) return null;
  const scaledPercent = roundDiv(numerator * 100n * SCALE, denominator);
  return format(scaledPercent, 2);
}

export type MarginEvidence = {
  definition: string;
  unit: string;
  period_start: string;
  period_end: string;
  freshness_at: string | null;
  source_reliability: MarginSourceReliability;
  source_type: string;
  source_ref: string | null;
  observed_at: string | null;
  assumption: string | null;
  assumption_date: string | null;
  rate_version_id: string | null;
  rate_id: string | null;
  rate_effective_at: string | null;
  rate_scope_type: string | null;
  rate_scope_ref: string | null;
  source_document_type: string | null;
  source_document_ref: string | null;
};

export type MarginCostInput = {
  key: string;
  category: MarginCostCategory;
  availability: MarginInputAvailability;
  amount_ht: string | null;
  quantity: string | null;
  rate: string | null;
  rate_unit: MarginRateUnit | null;
  currency: string;
  evidence: MarginEvidence;
};

export type MarginRevenueInput = {
  availability: MarginInputAvailability;
  amount_ht: string | null;
  currency: string;
  evidence: MarginEvidence;
};

export type MarginCalculationInput = {
  scope_type: MarginScopeType;
  scope_ref: string;
  label: string;
  basis: MarginBasis;
  as_of: string;
  revenue: MarginRevenueInput | null;
  costs: MarginCostInput[];
  required_categories?: readonly MarginCostCategory[];
  measurements?: Record<string, string | number | null>;
};

type ResolvedInput = MarginCostInput & { resolved_amount_ht: string | null };

function resolveInput(input: MarginCostInput, directSubtotal: bigint): { amount: bigint | null; row: ResolvedInput } {
  if (input.availability === "NOT_APPLICABLE") {
    return { amount: null, row: { ...input, resolved_amount_ht: null } };
  }
  let amount: bigint | null = null;
  try {
    if (input.amount_ht !== null) amount = decimal(input.amount_ht);
    else if (input.rate !== null && input.rate_unit !== null) {
      if (input.rate_unit === "PERCENT_OF_DIRECT_COST") {
        amount = roundDiv(directSubtotal * decimal(input.rate), 100n * SCALE);
      } else if (input.quantity !== null) {
        amount = multiply(decimal(input.quantity), decimal(input.rate));
      }
    }
  } catch {
    amount = null;
  }
  return { amount, row: { ...input, resolved_amount_ht: amount === null ? null : money(amount) } };
}

export type MarginCalculation = {
  formula_version: typeof MARGIN_FORMULA_VERSION;
  scope: { type: MarginScopeType; ref: string; label: string };
  basis: MarginBasis;
  as_of: string;
  currency: string;
  availability: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  reliability: MarginReliability;
  reliability_reasons: string[];
  definition: string;
  period: { start: string; end: string };
  freshness_at: string | null;
  formula: {
    gross_margin: "revenue_ht - cost_total_ht";
    margin_rate: "gross_margin_ht / cost_total_ht * 100";
    mark_rate: "gross_margin_ht / revenue_ht * 100";
  };
  revenue_ht: string | null;
  revenue_evidence: MarginEvidence | null;
  cost_total_ht: string | null;
  partial_cost_total_ht: string;
  gross_margin_ht: string | null;
  margin_rate_pct: string | null;
  mark_rate_pct: string | null;
  components: Array<{
    category: MarginCostCategory;
    status: "PROVIDED" | "NOT_APPLICABLE" | "MISSING";
    amount_ht: string | null;
    inputs: ResolvedInput[];
  }>;
  missing_inputs: Array<{ code: string; category: MarginCostCategory | "REVENUE"; message: string }>;
  measurements: Record<string, string | number | null>;
  waterfall: Array<{
    code: "PRICE" | "MATERIAL" | "TIME" | "SUBCONTRACTING" | "SCRAP_REWORK" | "OTHER" | "MARGIN";
    label: string;
    amount_ht: string | null;
    running_total_ht: string | null;
    available: boolean;
    source_categories: MarginCostCategory[];
  }>;
  calculation_hash: string;
};

function limitingFreshness(evidenceRows: Array<MarginEvidence | null>): string | null {
  const values = evidenceRows.flatMap((row) => row?.freshness_at ? [row.freshness_at] : []);
  return values.length > 0 ? values.sort().at(0)! : null;
}

function sumCategories(
  components: MarginCalculation["components"],
  categories: MarginCostCategory[],
): { amount: bigint | null; available: boolean } {
  const selected = components.filter((component) => categories.includes(component.category));
  if (selected.some((component) => component.status === "MISSING")) return { amount: null, available: false };
  return {
    amount: selected.reduce((sum, component) => sum + (component.amount_ht === null ? 0n : decimal(component.amount_ht)), 0n),
    available: true,
  };
}

function buildWaterfall(
  revenue: bigint | null,
  components: MarginCalculation["components"],
  grossMargin: bigint | null,
): MarginCalculation["waterfall"] {
  const groups: Array<{
    code: MarginCalculation["waterfall"][number]["code"];
    label: string;
    categories: MarginCostCategory[];
  }> = [
    { code: "MATERIAL", label: "Matière et achats", categories: ["MATERIAL", "PURCHASE"] },
    { code: "TIME", label: "Temps machine et main-d'œuvre", categories: ["MACHINE", "OPERATOR", "CONTROL"] },
    { code: "SUBCONTRACTING", label: "Sous-traitance", categories: ["SUBCONTRACTING"] },
    { code: "SCRAP_REWORK", label: "Rebuts et retouches", categories: ["SCRAP", "REWORK"] },
    { code: "OTHER", label: "Autres coûts", categories: ["TOOLING", "PACKAGING", "TRANSPORT", "OVERHEAD"] },
  ];
  let running = revenue;
  const rows: MarginCalculation["waterfall"] = [{
    code: "PRICE", label: "Prix de vente HT", amount_ht: revenue === null ? null : money(revenue),
    running_total_ht: revenue === null ? null : money(revenue), available: revenue !== null, source_categories: [],
  }];
  for (const group of groups) {
    const value = sumCategories(components, group.categories);
    if (running !== null && value.amount !== null) running -= value.amount;
    else running = null;
    rows.push({
      code: group.code,
      label: group.label,
      amount_ht: value.amount === null ? null : money(-value.amount),
      running_total_ht: running === null ? null : money(running),
      available: value.available,
      source_categories: group.categories,
    });
  }
  rows.push({
    code: "MARGIN", label: "Marge brute HT", amount_ht: grossMargin === null ? null : money(grossMargin),
    running_total_ht: grossMargin === null ? null : money(grossMargin), available: grossMargin !== null, source_categories: [],
  });
  return rows;
}

export function calculateMargin(input: MarginCalculationInput): MarginCalculation {
  const required = input.required_categories ?? MARGIN_COST_CATEGORIES;
  const missing: MarginCalculation["missing_inputs"] = [];
  let revenue: bigint | null = null;
  if (input.revenue?.availability === "PROVIDED" && input.revenue.amount_ht !== null) {
    try { revenue = decimal(input.revenue.amount_ht); } catch { revenue = null; }
  }
  if (revenue === null) {
    missing.push({ code: "REVENUE_HT_MISSING", category: "REVENUE", message: "Prix de vente HT/remises non attribués à ce périmètre." });
  }

  const nonOverhead = input.costs.filter((item) => item.category !== "OVERHEAD");
  const overhead = input.costs.filter((item) => item.category === "OVERHEAD");
  const firstPass = nonOverhead.map((item) => resolveInput(item, 0n));
  const directSubtotal = firstPass.reduce((sum, item) => sum + (item.amount ?? 0n), 0n);
  const resolved = [...firstPass, ...overhead.map((item) => resolveInput(item, directSubtotal))];

  const components = MARGIN_COST_CATEGORIES.map((category) => {
    const categoryRows = resolved.filter((entry) => entry.row.category === category);
    const provided = categoryRows.filter((entry) => entry.row.availability === "PROVIDED" && entry.amount !== null);
    const explicitNa = categoryRows.some((entry) => entry.row.availability === "NOT_APPLICABLE");
    const invalid = categoryRows.some((entry) => entry.row.availability === "PROVIDED" && entry.amount === null);
    const status = invalid ? "MISSING" : provided.length > 0 ? "PROVIDED" : explicitNa ? "NOT_APPLICABLE" : "MISSING";
    const amount = provided.reduce((sum, entry) => sum + (entry.amount ?? 0n), 0n);
    if (required.includes(category) && status === "MISSING") {
      missing.push({
        code: `${category}_MISSING`,
        category,
        message: invalid ? `Entrée ${category} incomplète : montant ou taux manquant.` : `Entrée ${category} absente (elle n'est pas assimilée à zéro).`,
      });
    }
    return {
      category,
      status,
      amount_ht: status === "PROVIDED" ? money(amount) : null,
      inputs: categoryRows.map((entry) => entry.row),
    } as MarginCalculation["components"][number];
  });

  const partialCost = resolved.reduce((sum, entry) => sum + (entry.amount ?? 0n), 0n);
  const costMissing = missing.some((entry) => entry.category !== "REVENUE");
  const complete = revenue !== null && !costMissing;
  const costTotal = costMissing ? null : partialCost;
  const grossMargin = complete && costTotal !== null ? revenue! - costTotal : null;
  const availability: MarginCalculation["availability"] = complete
    ? "COMPLETE"
    : revenue === null && partialCost === 0n
      ? "UNAVAILABLE"
      : "PARTIAL";

  const providedEvidence = resolved
    .filter((entry) => entry.row.availability === "PROVIDED")
    .map((entry) => entry.row.evidence);
  if (input.revenue?.availability === "PROVIDED") providedEvidence.push(input.revenue.evidence);
  const reliabilityReasons: string[] = [];
  let reliability: MarginReliability;
  if (!complete) {
    reliability = "PARTIAL";
    reliabilityReasons.push("Au moins une donnée requise est absente ou non valorisable.");
  } else if (input.basis === "ACTUAL" && providedEvidence.every((row) => row.source_reliability === "VERIFIED")) {
    reliability = "ACTUAL";
    reliabilityReasons.push("Toutes les valeurs publiées proviennent de sources constatées et vérifiées.");
  } else {
    reliability = "ESTIMATED";
    reliabilityReasons.push(input.basis === "ACTUAL"
      ? "Le périmètre réel contient au moins une donnée déclarée ou estimée."
      : "Cette perspective utilise par définition des hypothèses ou paramètres prévisionnels.");
  }
  const freshnessAt = limitingFreshness(providedEvidence);

  const unsigned = {
    formula_version: MARGIN_FORMULA_VERSION,
    scope: { type: input.scope_type, ref: input.scope_ref, label: input.label },
    basis: input.basis,
    as_of: input.as_of,
    currency: input.revenue?.currency ?? MARGIN_CURRENCY,
    availability,
    reliability,
    reliability_reasons: reliabilityReasons,
    definition: input.basis === "QUOTED"
      ? "Marge issue des coûts et du prix figés dans le devis."
      : input.basis === "STANDARD"
        ? "Marge calculée avec les quantités prévues et les paramètres de coût applicables à la date."
        : input.basis === "UPDATED"
          ? "Marge actualisée à date : coûts engagés disponibles et temps à terminaison valorisé sur max(prévu, réel), sans remplacer les inconnues par zéro."
          : "Marge constatée à partir des consommations, temps, achats, rebuts et retouches enregistrés.",
    period: { start: input.as_of, end: input.as_of },
    freshness_at: freshnessAt,
    formula: {
      gross_margin: "revenue_ht - cost_total_ht" as const,
      margin_rate: "gross_margin_ht / cost_total_ht * 100" as const,
      mark_rate: "gross_margin_ht / revenue_ht * 100" as const,
    },
    revenue_ht: revenue === null ? null : money(revenue),
    revenue_evidence: input.revenue?.evidence ?? null,
    cost_total_ht: costTotal === null ? null : money(costTotal),
    partial_cost_total_ht: money(partialCost),
    gross_margin_ht: grossMargin === null ? null : money(grossMargin),
    // Taux de marge = marge / coût de revient. Taux de marque = marge / prix de vente HT.
    margin_rate_pct: grossMargin === null || costTotal === null ? null : percentage(grossMargin, costTotal),
    mark_rate_pct: grossMargin === null || revenue === null ? null : percentage(grossMargin, revenue!),
    components,
    missing_inputs: missing,
    measurements: input.measurements ?? {},
    waterfall: buildWaterfall(revenue, components, grossMargin),
  };
  const calculation_hash = crypto.createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  return { ...unsigned, calculation_hash };
}

export type MarginComparison = {
  quoted: MarginCalculation;
  standard: MarginCalculation;
  updated: MarginCalculation;
  actual: MarginCalculation;
  variances: {
    actual_vs_standard: {
      available: boolean;
      cost_ht: string | null;
      gross_margin_ht: string | null;
      reason: string | null;
    };
    updated_vs_quoted: {
      available: boolean;
      cost_ht: string | null;
      gross_margin_ht: string | null;
      reason: string | null;
    };
  };
};

function variance(left: MarginCalculation, right: MarginCalculation) {
  const canCompare = left.cost_total_ht !== null && right.cost_total_ht !== null && left.gross_margin_ht !== null && right.gross_margin_ht !== null;
  return canCompare
    ? {
        available: true,
        cost_ht: money(decimal(right.cost_total_ht!) - decimal(left.cost_total_ht!)),
        gross_margin_ht: money(decimal(right.gross_margin_ht!) - decimal(left.gross_margin_ht!)),
        reason: null,
      }
    : {
        available: false,
        cost_ht: null,
        gross_margin_ht: null,
        reason: "Écart indisponible tant que les deux perspectives ne sont pas complètes.",
      };
}

export function compareMargins(
  quoted: MarginCalculation,
  standard: MarginCalculation,
  updated: MarginCalculation,
  actual: MarginCalculation,
): MarginComparison {
  return {
    quoted,
    standard,
    updated,
    actual,
    variances: {
      actual_vs_standard: variance(standard, actual),
      updated_vs_quoted: variance(quoted, updated),
    },
  };
}
