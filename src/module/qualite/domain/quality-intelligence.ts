export const QUALITY_METRIC_RELIABILITIES = ["CONFIRMED", "PARTIAL", "UNAVAILABLE"] as const;
export type QualityMetricReliability = (typeof QUALITY_METRIC_RELIABILITIES)[number];

export type QualityDecisionMetric = {
  code: "FPY" | "PPM" | "CLOSURE_DELAY" | "SCRAP_COST" | "REWORK_COST" | "COPQ";
  label: string;
  value: number | null;
  unit: "%" | "ppm" | "days" | "currency";
  currency: string | null;
  numerator: number | null;
  denominator: number | null;
  reliability: QualityMetricReliability;
  missing: string[];
  formula: string;
  source: string[];
};

export type QualityMetricInputs = {
  firstPassConformingQty: number;
  firstPassControlledQty: number;
  firstPassMissingData: number;
  defectQty: number;
  controlledQty: number;
  controlsMissingQuantities: number;
  closureDurationsDays: number[];
  scrapCost: number | null;
  reworkCost: number | null;
  otherPoorQualityCost: number | null;
  costCurrency: string | null;
  costCurrencyCount: number;
};

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function ratioReliability(denominator: number, missing: number): QualityMetricReliability {
  if (denominator <= 0) return "UNAVAILABLE";
  return missing > 0 ? "PARTIAL" : "CONFIRMED";
}

function costMetric(params: {
  code: "SCRAP_COST" | "REWORK_COST" | "COPQ";
  label: string;
  amount: number | null;
  currency: string | null;
  currencyCount: number;
  source: string[];
  additionalMissing?: string[];
}): QualityDecisionMetric {
  const missing: string[] = [...(params.additionalMissing ?? [])];
  if (params.amount === null) missing.push("cost_entries");
  if (!params.currency) missing.push("currency");
  if (params.currencyCount > 1) missing.push("currency_conversion_policy");
  const available = params.amount !== null && Boolean(params.currency) && params.currencyCount <= 1;
  const reliability: QualityMetricReliability = !available
    ? "UNAVAILABLE"
    : missing.length > 0
      ? "PARTIAL"
      : "CONFIRMED";
  return {
    code: params.code,
    label: params.label,
    value: available ? round(params.amount!, 2) : null,
    unit: "currency",
    currency: available ? params.currency : null,
    numerator: available ? params.amount : null,
    denominator: null,
    reliability,
    missing,
    formula: "Somme des écritures de coût qualité immuables de la catégorie sur la période.",
    source: params.source,
  };
}

/**
 * Calculs purs des indicateurs SOL-22. Une absence de dénominateur ou de coût
 * reste `null`; elle n'est jamais maquillée en zéro.
 */
export function computeQualityDecisionMetrics(input: QualityMetricInputs): QualityDecisionMetric[] {
  const fpyReliability = ratioReliability(input.firstPassControlledQty, input.firstPassMissingData);
  const ppmReliability = ratioReliability(input.controlledQty, input.controlsMissingQuantities);
  const closureCount = input.closureDurationsDays.length;
  const closureSum = input.closureDurationsDays.reduce((sum, value) => sum + value, 0);

  const scrap = costMetric({
    code: "SCRAP_COST",
    label: "Coût des rebuts",
    amount: input.scrapCost,
    currency: input.costCurrency,
    currencyCount: input.costCurrencyCount,
    source: ["quality_cost_entry(category=SCRAP)"],
  });
  const rework = costMetric({
    code: "REWORK_COST",
    label: "Coût des retouches",
    amount: input.reworkCost,
    currency: input.costCurrency,
    currencyCount: input.costCurrencyCount,
    source: ["quality_cost_entry(category=REWORK)"],
  });
  const allCosts = [input.scrapCost, input.reworkCost, input.otherPoorQualityCost];
  const missingCopqCategories = [
    input.scrapCost === null ? "scrap_cost_entries" : null,
    input.reworkCost === null ? "rework_cost_entries" : null,
    input.otherPoorQualityCost === null ? "other_quality_cost_entries" : null,
  ].filter((value): value is string => value !== null);
  const copqAmount = allCosts.every((value) => value === null)
    ? null
    : allCosts.reduce<number>((sum, value) => sum + (value ?? 0), 0);

  return [
    {
      code: "FPY",
      label: "Rendement au premier passage",
      value: fpyReliability === "UNAVAILABLE"
        ? null
        : round((input.firstPassConformingQty / input.firstPassControlledQty) * 100, 2),
      unit: "%",
      currency: null,
      numerator: fpyReliability === "UNAVAILABLE" ? null : input.firstPassConformingQty,
      denominator: fpyReliability === "UNAVAILABLE" ? null : input.firstPassControlledQty,
      reliability: fpyReliability,
      missing: input.firstPassControlledQty <= 0
        ? ["first_pass_quantities"]
        : input.firstPassMissingData > 0
          ? ["first_pass_source_or_quantity"]
          : [],
      formula: "Quantité conforme au premier passage / quantité contrôlée au premier passage × 100.",
      source: ["quality_control.qty_conforming", "quality_control.qty_controlled", "quality_control.source_type", "quality_control.source_id", "quality_control.validation_date"],
    },
    {
      code: "PPM",
      label: "Pièces non conformes par million contrôlé",
      value: ppmReliability === "UNAVAILABLE" ? null : round((input.defectQty / input.controlledQty) * 1_000_000, 0),
      unit: "ppm",
      currency: null,
      numerator: ppmReliability === "UNAVAILABLE" ? null : input.defectQty,
      denominator: ppmReliability === "UNAVAILABLE" ? null : input.controlledQty,
      reliability: ppmReliability,
      missing: input.controlledQty <= 0
        ? ["controlled_quantity"]
        : input.controlsMissingQuantities > 0
          ? ["controlled_or_conforming_quantity"]
          : [],
      formula: "(Quantité contrôlée − quantité conforme) / quantité contrôlée × 1 000 000.",
      source: ["quality_control.qty_controlled", "quality_control.qty_conforming", "quality_control.validation_date"],
    },
    {
      code: "CLOSURE_DELAY",
      label: "Délai moyen de clôture des non-conformités",
      value: closureCount > 0 ? round(closureSum / closureCount, 2) : null,
      unit: "days",
      currency: null,
      numerator: closureCount > 0 ? round(closureSum, 4) : null,
      denominator: closureCount > 0 ? closureCount : null,
      reliability: closureCount > 0 ? "CONFIRMED" : "UNAVAILABLE",
      missing: closureCount > 0 ? [] : ["closed_non_conformities"],
      formula: "Moyenne de (date de clôture − date de détection) en jours calendaires.",
      source: ["non_conformity.detection_date", "non_conformity.closed_at"],
    },
    scrap,
    rework,
    costMetric({
      code: "COPQ",
      label: "Coût de non-qualité",
      amount: copqAmount,
      currency: input.costCurrency,
      currencyCount: input.costCurrencyCount,
      source: ["quality_cost_entry"],
      additionalMissing: missingCopqCategories,
    }),
  ];
}

export type SpcReadinessInput = {
  policyActive: boolean;
  samplingRule: string | null;
  expectedUnit: string | null;
  cadenceMinutes: number | null;
  subgroupSize: number | null;
  minSubgroups: number | null;
  observedSubgroups: number;
  observedUnits: string[];
  cadenceCoverageRatio: number | null;
};

export type SpcReadiness = {
  enabled: boolean;
  reliability: QualityMetricReliability;
  missing: string[];
};

/** SPC est refusé par défaut tant que plan, unité, cadence et volume ne sont pas prouvés. */
export function assessSpcReadiness(input: SpcReadinessInput): SpcReadiness {
  const missing: string[] = [];
  if (!input.policyActive) missing.push("active_spc_policy");
  if (!input.samplingRule) missing.push("sampling_rule");
  if (!input.expectedUnit) missing.push("expected_unit");
  if (!input.cadenceMinutes || input.cadenceMinutes <= 0) missing.push("sampling_frequency");
  if (!input.subgroupSize || input.subgroupSize < 2) missing.push("subgroup_size");
  if (!input.minSubgroups || input.minSubgroups < 2) missing.push("minimum_subgroups");
  if (input.expectedUnit && (input.observedUnits.length !== 1 || input.observedUnits[0] !== input.expectedUnit)) {
    missing.push("consistent_observed_unit");
  }
  if (input.minSubgroups && input.observedSubgroups < input.minSubgroups) missing.push("observed_subgroups");
  if (input.cadenceCoverageRatio === null || input.cadenceCoverageRatio < 0.9) missing.push("sampling_cadence_coverage");
  return {
    enabled: missing.length === 0,
    reliability: missing.length === 0 ? "CONFIRMED" : input.observedSubgroups > 0 ? "PARTIAL" : "UNAVAILABLE",
    missing,
  };
}
