import { buildPlanningExecutionIntelligence } from "../domain/planning-intelligence";
import { roleHasPlanningCapability } from "../domain/planning-rbac";
import {
  repoGetPlanningIntelligenceSnapshot,
  repoGetPlanningPreferences,
  repoPutPlanningPreferences,
} from "../repository/planning-intelligence.repository";
import type { AuditContext } from "../repository/planning.repository";
import type { PlanningPreferencesBodyDTO, PlanningIntelligenceQueryDTO } from "../validators/planning-intelligence.validators";

export async function svcGetPlanningExecutionIntelligence(params: {
  query: PlanningIntelligenceQueryDTO;
  role: string | null | undefined;
}) {
  const snapshot = await repoGetPlanningIntelligenceSnapshot(params.query);
  return buildPlanningExecutionIntelligence({
    snapshot,
    from: params.query.from,
    to: params.query.to,
    timezone: params.query.timezone,
    agedWipDays: params.query.aged_wip_days,
    capabilities: {
      read_capacity: roleHasPlanningCapability(params.role, "read_capacity"),
      manage_schedule: roleHasPlanningCapability(params.role, "manage_schedule"),
      manage_preferences: roleHasPlanningCapability(params.role, "manage_preferences"),
      supervise_execution: roleHasPlanningCapability(params.role, "supervise_execution"),
    },
  });
}

export function svcGetPlanningPreferences(userId: number) {
  return repoGetPlanningPreferences(userId);
}

export function svcPutPlanningPreferences(params: { body: PlanningPreferencesBodyDTO; audit: AuditContext }) {
  return repoPutPlanningPreferences(params);
}
