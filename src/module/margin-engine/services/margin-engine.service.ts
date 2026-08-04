import { HttpError } from "../../../utils/httpError";
import { calculateMargin, compareMargins, type MarginBasis, type MarginComparison, type MarginScopeType } from "../domain/margin-engine";
import {
  repoBuildCalculationInput,
  repoCreateMarginInput,
  repoCreateRateVersion,
  repoCreateSnapshot,
  repoListRateVersions,
  repoListSnapshots,
  repoLoadScopeIdentity,
  type MarginAuditContext,
} from "../repository/margin-engine.repository";
import type { CreateMarginInput, CreateRateVersion } from "../validators/margin-engine.validators";

function currentDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
}

export function assertCurrentMarginDate(asOf: string): void {
  if (asOf !== currentDate()) {
    throw new HttpError(
      409,
      "MARGIN_HISTORICAL_RECALCULATION_FORBIDDEN",
      "Un état passé ne peut pas être recalculé depuis les données courantes. Consultez une preuve de recalcul immuable.",
    );
  }
}

export async function svcGetMargin(scopeType: MarginScopeType, scopeRef: string, asOf = currentDate()) {
  assertCurrentMarginDate(asOf);
  const identity = await repoLoadScopeIdentity(scopeType, scopeRef);
  if (!identity) throw new HttpError(404, "MARGIN_SCOPE_NOT_FOUND", "Périmètre de marge introuvable.");
  const [plannedInput, actualInput] = await Promise.all([
    repoBuildCalculationInput(identity, "PLANNED", asOf),
    repoBuildCalculationInput(identity, "ACTUAL", asOf),
  ]);
  const comparison = compareMargins(calculateMargin(plannedInput), calculateMargin(actualInput));
  return { ...comparison, generated_at: new Date().toISOString() };
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

type GeneratedMarginComparison = MarginComparison & { generated_at: string };

export function renderMarginCsv(result: GeneratedMarginComparison): string {
  const rows: unknown[][] = [[
    "record_type", "scope_type", "scope_ref", "scope_label", "basis", "as_of", "generated_at", "availability",
    "category", "component_status", "component_amount_ht", "input_key", "resolved_input_amount_ht",
    "input_quantity", "rate_amount", "rate_unit", "input_currency",
    "source_type", "source_ref", "observed_at", "assumption", "assumption_date",
    "rate_id", "rate_version_id", "rate_effective_at", "rate_scope_type", "rate_scope_ref",
    "missing_code", "missing_message", "measurement_key", "measurement_value",
    "revenue_ht", "cost_total_ht", "partial_cost_total_ht", "gross_margin_ht",
    "taux_de_marge_pct", "taux_de_marque_pct", "formula_version", "calculation_hash",
  ]];
  for (const calculation of [result.planned, result.actual]) {
    const base = [
      calculation.scope.type, calculation.scope.ref, calculation.scope.label, calculation.basis,
      calculation.as_of, result.generated_at, calculation.availability,
    ];
    const totals = [
      calculation.revenue_ht, calculation.cost_total_ht, calculation.partial_cost_total_ht,
      calculation.gross_margin_ht, calculation.margin_rate_pct, calculation.mark_rate_pct,
      calculation.formula_version, calculation.calculation_hash,
    ];
    const revenueEvidence = calculation.revenue_evidence;
    rows.push([
      "REVENUE", ...base, "REVENUE", calculation.revenue_ht === null ? "MISSING" : "PROVIDED",
      calculation.revenue_ht, "revenue", calculation.revenue_ht,
      null, null, null, calculation.currency,
      revenueEvidence?.source_type, revenueEvidence?.source_ref, revenueEvidence?.observed_at,
      revenueEvidence?.assumption, revenueEvidence?.assumption_date,
      revenueEvidence?.rate_id, revenueEvidence?.rate_version_id, revenueEvidence?.rate_effective_at,
      revenueEvidence?.rate_scope_type, revenueEvidence?.rate_scope_ref,
      null, null, null, null, ...totals,
    ]);
    for (const component of calculation.components) {
      const inputs = component.inputs.length > 0 ? component.inputs : [null];
      for (const input of inputs) {
        rows.push([
          "COMPONENT", ...base, component.category, component.status, component.amount_ht,
          input?.key, input?.resolved_amount_ht,
          input?.quantity, input?.rate, input?.rate_unit, input?.currency,
          input?.evidence.source_type, input?.evidence.source_ref, input?.evidence.observed_at,
          input?.evidence.assumption, input?.evidence.assumption_date,
          input?.evidence.rate_id, input?.evidence.rate_version_id, input?.evidence.rate_effective_at,
          input?.evidence.rate_scope_type, input?.evidence.rate_scope_ref,
          null, null, null, null, ...totals,
        ]);
      }
    }
    for (const missing of calculation.missing_inputs) {
      rows.push([
        "MISSING", ...base, missing.category, "MISSING", null, null, null,
        null, null, null, null,
        null, null, null, null, null, null, null, null, null, null,
        missing.code, missing.message, null, null, ...totals,
      ]);
    }
    for (const [key, value] of Object.entries(calculation.measurements)) {
      rows.push([
        "MEASUREMENT", ...base, null, null, null, null, null,
        null, null, null, null,
        null, null, null, null, null, null, null, null, null, null,
        null, null, key, value, ...totals,
      ]);
    }
  }
  return `\ufeff${rows.map((row) => row.map(csvCell).join(";")).join("\r\n")}\r\n`;
}

export async function svcExportMargin(scopeType: MarginScopeType, scopeRef: string, asOf?: string): Promise<string> {
  return renderMarginCsv(await svcGetMargin(scopeType, scopeRef, asOf));
}

export async function svcCreateMarginInput(input: CreateMarginInput, audit: MarginAuditContext) {
  return repoCreateMarginInput(input, audit);
}

export async function svcCreateRateVersion(input: CreateRateVersion, audit: MarginAuditContext) {
  return repoCreateRateVersion(input, audit);
}

export async function svcListRateVersions(asOf = currentDate()) {
  return repoListRateVersions(asOf);
}

export async function svcCreateMarginSnapshot(
  scopeType: MarginScopeType,
  scopeRef: string,
  basis: MarginBasis,
  asOf: string | undefined,
  audit: MarginAuditContext,
) {
  const effectiveAsOf = asOf ?? currentDate();
  assertCurrentMarginDate(effectiveAsOf);
  const identity = await repoLoadScopeIdentity(scopeType, scopeRef);
  if (!identity) throw new HttpError(404, "MARGIN_SCOPE_NOT_FOUND", "Périmètre de marge introuvable.");
  const input = await repoBuildCalculationInput(identity, basis, effectiveAsOf);
  const calculation = calculateMargin(input);
  return repoCreateSnapshot(calculation, input, audit);
}

export async function svcListMarginSnapshots(
  scopeType: MarginScopeType,
  scopeRef: string,
  filters: { basis?: MarginBasis; as_of?: string },
) {
  return repoListSnapshots(scopeType, scopeRef, filters);
}
