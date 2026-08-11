import { productionReadinessCapabilitiesFor } from "../domain/production-readiness-policy";
import {
  repoCreateCalendarClosure,
  repoCreateProductionCalendar,
  repoDeleteCalendarClosure,
  repoListProductionCalendars,
  repoReadProductionPrerequisites,
  repoUpdateProductionCalendar,
} from "../repository/production-readiness.repository";
import type {
  ProductionReadinessAuditContext,
  ProductionReadinessDTO,
} from "../types/production-readiness.types";
import type {
  ProductionCalendarClosureInput,
  ProductionCalendarInput,
  UpdateProductionCalendarInput,
} from "../validators/production-readiness.validators";

const ACTIONS: Record<string, { path: string; label: string; capability: "calendar_write" | "cost_center_write" | "rate_write" }> = {
  ACTIVE_PRODUCTION_CALENDAR: {
    path: "/planning/parametres/calendriers",
    label: "Configurer les calendriers",
    capability: "calendar_write",
  },
  CURRENT_COST_CENTER_RATES: {
    path: "/methodes/centres-frais",
    label: "Renseigner les taux horaires",
    capability: "rate_write",
  },
};

export async function readProductionReadinessSVC(role: string | null | undefined): Promise<ProductionReadinessDTO> {
  const capabilities = productionReadinessCapabilitiesFor(role);
  const rows = await repoReadProductionPrerequisites();
  const prerequisites = rows.map((row) => {
    const action = ACTIONS[row.prerequisite_code] ?? {
      path: "/administration/preparation-production",
      label: "Voir le centre de préparation",
      capability: "view" as const,
    };
    return {
      code: row.prerequisite_code,
      ready: row.ready,
      definition: row.definition,
      unit: row.unit,
      period_start: row.period_start,
      period_end: row.period_end,
      source: row.source,
      freshness_at: row.freshness_at,
      reliability: row.reliability,
      actual_value: row.actual_value,
      expected_value: row.expected_value,
      remediation: row.remediation,
      action_path: action.path,
      action_label: action.label,
      can_manage: Boolean(capabilities[action.capability]),
    };
  });
  return {
    flow: "PRODUCTION",
    ready: prerequisites.length > 0 && prerequisites.every((item) => item.ready),
    checked_at: new Date().toISOString(),
    capabilities,
    prerequisites,
  };
}

export const listProductionCalendarsSVC = repoListProductionCalendars;
export const createProductionCalendarSVC = (
  input: ProductionCalendarInput,
  audit: ProductionReadinessAuditContext
) => repoCreateProductionCalendar(input, audit);
export const updateProductionCalendarSVC = (
  calendarId: string,
  input: UpdateProductionCalendarInput,
  audit: ProductionReadinessAuditContext
) => repoUpdateProductionCalendar(calendarId, input, audit);
export const createCalendarClosureSVC = (
  calendarId: string,
  input: ProductionCalendarClosureInput,
  audit: ProductionReadinessAuditContext
) => repoCreateCalendarClosure(calendarId, input, audit);
export const deleteCalendarClosureSVC = (
  calendarId: string,
  closureId: string,
  audit: ProductionReadinessAuditContext
) => repoDeleteCalendarClosure(calendarId, closureId, audit);
