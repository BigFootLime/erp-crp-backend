import { HttpError } from "../../../utils/httpError";
import { calculateMargin, compareMargins, type MarginBasis, type MarginScopeType } from "../domain/margin-engine";
import {
  repoBuildCalculationInput,
  repoCreateMarginInput,
  repoCreateRateVersion,
  repoCreateSnapshot,
  repoListRateVersions,
  repoLoadScopeIdentity,
} from "../repository/margin-engine.repository";
import type { CreateMarginInput, CreateRateVersion } from "../validators/margin-engine.validators";

function currentDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function svcGetMargin(scopeType: MarginScopeType, scopeRef: string, asOf = currentDate()) {
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

export async function svcExportMargin(scopeType: MarginScopeType, scopeRef: string, asOf?: string): Promise<string> {
  const result = await svcGetMargin(scopeType, scopeRef, asOf);
  const rows: unknown[][] = [[
    "scope_type", "scope_ref", "basis", "availability", "category", "status", "amount_ht",
    "revenue_ht", "cost_total_ht", "gross_margin_ht", "taux_de_marge_pct", "taux_de_marque_pct",
    "formula_version", "calculation_hash",
  ]];
  for (const calculation of [result.planned, result.actual]) {
    for (const component of calculation.components) {
      rows.push([
        calculation.scope.type, calculation.scope.ref, calculation.basis, calculation.availability,
        component.category, component.status, component.amount_ht, calculation.revenue_ht,
        calculation.cost_total_ht, calculation.gross_margin_ht, calculation.margin_rate_pct,
        calculation.mark_rate_pct, calculation.formula_version, calculation.calculation_hash,
      ]);
    }
  }
  return `\ufeff${rows.map((row) => row.map(csvCell).join(";")).join("\r\n")}\r\n`;
}

export async function svcCreateMarginInput(input: CreateMarginInput, userId: number) {
  return repoCreateMarginInput(input, userId);
}

export async function svcCreateRateVersion(input: CreateRateVersion, userId: number) {
  return repoCreateRateVersion(input, userId);
}

export async function svcListRateVersions(asOf = currentDate()) {
  return repoListRateVersions(asOf);
}

export async function svcCreateMarginSnapshot(
  scopeType: MarginScopeType,
  scopeRef: string,
  basis: MarginBasis,
  asOf: string,
  userId: number,
) {
  const identity = await repoLoadScopeIdentity(scopeType, scopeRef);
  if (!identity) throw new HttpError(404, "MARGIN_SCOPE_NOT_FOUND", "Périmètre de marge introuvable.");
  const input = await repoBuildCalculationInput(identity, basis, asOf);
  const calculation = calculateMargin(input);
  return repoCreateSnapshot(calculation, input, userId);
}
