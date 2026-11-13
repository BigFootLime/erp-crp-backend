import { effectiveRoleHasAny, hasAnyAssignedRole } from "../../auth/domain/roles";

export function canValidateTechnicalDossier(user?: { role?: string; primary_role?: string; roles?: string[] }): boolean {
  const qualityRoles = ["Responsable Qualité", "Qualité"];
  return effectiveRoleHasAny(user?.role, qualityRoles)
    || hasAnyAssignedRole(user?.primary_role, user?.roles, qualityRoles);
}
