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
  const [quotedInput, standardInput, updatedInput, actualInput] = await Promise.all([
    repoBuildCalculationInput(identity, "QUOTED", asOf),
    repoBuildCalculationInput(identity, "STANDARD", asOf),
    repoBuildCalculationInput(identity, "UPDATED", asOf),
    repoBuildCalculationInput(identity, "ACTUAL", asOf),
  ]);
  const comparison = compareMargins(
    calculateMargin(quotedInput),
    calculateMargin(standardInput),
    calculateMargin(updatedInput),
    calculateMargin(actualInput),
  );
  return { ...comparison, generated_at: new Date().toISOString() };
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

type GeneratedMarginComparison = MarginComparison & { generated_at: string };

export function renderMarginCsv(result: GeneratedMarginComparison): string {
  const headers = [
    "record_type", "scope_type", "scope_ref", "scope_label", "basis", "as_of", "generated_at", "availability",
    "reliability", "reliability_reasons", "calculation_definition", "period_start", "period_end", "calculation_freshness_at",
    "category", "component_status", "component_amount_ht", "input_key", "resolved_input_amount_ht",
    "input_quantity", "rate_amount", "rate_unit", "input_currency",
    "evidence_definition", "evidence_unit", "evidence_period_start", "evidence_period_end", "evidence_freshness_at", "source_reliability",
    "source_type", "source_ref", "source_document_type", "source_document_ref", "observed_at", "assumption", "assumption_date",
    "rate_id", "rate_version_id", "rate_effective_at", "rate_scope_type", "rate_scope_ref",
    "missing_code", "missing_message", "measurement_key", "measurement_value",
    "revenue_ht", "cost_total_ht", "partial_cost_total_ht", "gross_margin_ht",
    "taux_de_marge_pct", "taux_de_marque_pct", "formula_version", "calculation_hash",
  ] as const;
  const records: Array<Record<string, unknown>> = [];
  for (const calculation of [result.quoted, result.standard, result.updated, result.actual]) {
    const base: Record<string, unknown> = {
      scope_type: calculation.scope.type, scope_ref: calculation.scope.ref, scope_label: calculation.scope.label,
      basis: calculation.basis, as_of: calculation.as_of, generated_at: result.generated_at,
      availability: calculation.availability, reliability: calculation.reliability,
      reliability_reasons: calculation.reliability_reasons.join(" | "),
      calculation_definition: calculation.definition,
      period_start: calculation.period.start, period_end: calculation.period.end,
      calculation_freshness_at: calculation.freshness_at,
      revenue_ht: calculation.revenue_ht, cost_total_ht: calculation.cost_total_ht,
      partial_cost_total_ht: calculation.partial_cost_total_ht, gross_margin_ht: calculation.gross_margin_ht,
      taux_de_marge_pct: calculation.margin_rate_pct, taux_de_marque_pct: calculation.mark_rate_pct,
      formula_version: calculation.formula_version, calculation_hash: calculation.calculation_hash,
    };
    const evidenceFields = (proof: typeof calculation.revenue_evidence): Record<string, unknown> => proof ? ({
      evidence_definition: proof.definition, evidence_unit: proof.unit,
      evidence_period_start: proof.period_start, evidence_period_end: proof.period_end,
      evidence_freshness_at: proof.freshness_at, source_reliability: proof.source_reliability,
      source_type: proof.source_type, source_ref: proof.source_ref,
      source_document_type: proof.source_document_type, source_document_ref: proof.source_document_ref,
      observed_at: proof.observed_at, assumption: proof.assumption, assumption_date: proof.assumption_date,
      rate_id: proof.rate_id, rate_version_id: proof.rate_version_id, rate_effective_at: proof.rate_effective_at,
      rate_scope_type: proof.rate_scope_type, rate_scope_ref: proof.rate_scope_ref,
    }) : {};
    const revenueEvidence = calculation.revenue_evidence;
    records.push({ ...base, record_type: "REVENUE", category: "REVENUE",
      component_status: calculation.revenue_ht === null ? "MISSING" : "PROVIDED",
      component_amount_ht: calculation.revenue_ht, input_key: "revenue",
      resolved_input_amount_ht: calculation.revenue_ht, input_currency: calculation.currency,
      ...evidenceFields(revenueEvidence) });
    for (const component of calculation.components) {
      const inputs = component.inputs.length > 0 ? component.inputs : [null];
      for (const input of inputs) {
        records.push({ ...base, record_type: "COMPONENT", category: component.category,
          component_status: component.status, component_amount_ht: component.amount_ht,
          input_key: input?.key, resolved_input_amount_ht: input?.resolved_amount_ht,
          input_quantity: input?.quantity, rate_amount: input?.rate, rate_unit: input?.rate_unit,
          input_currency: input?.currency, ...evidenceFields(input?.evidence ?? null) });
      }
    }
    for (const missing of calculation.missing_inputs) {
      records.push({ ...base, record_type: "MISSING", category: missing.category,
        component_status: "MISSING", missing_code: missing.code, missing_message: missing.message });
    }
    for (const [key, value] of Object.entries(calculation.measurements)) {
      records.push({ ...base, record_type: "MEASUREMENT", measurement_key: key, measurement_value: value });
    }
  }
  const rows = [headers.map(csvCell), ...records.map((record) => headers.map((header) => csvCell(record[header] ?? null)))];
  return `\ufeff${rows.map((row) => row.join(";")).join("\r\n")}\r\n`;
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
