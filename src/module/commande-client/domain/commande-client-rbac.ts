import { effectiveRoleHasAny } from "../../auth/domain/roles";

export const INTERNAL_ORDER_LAUNCH_ROLES = [
  "Directeur",
  "Administrateur Systeme et Reseau",
  "Production",
  "Responsable Programmation",
  // Historical signed sessions and test fixtures kept during the multi-role
  // transition. Exact matching preserves their previous scope without
  // reintroducing substring-based role inference.
  "Directeur industriel",
  "Responsable Production",
  "Responsable Atelier",
  "Chef Atelier",
] as const;

export function canLaunchInternalOrder(role: string | null | undefined): boolean {
  return effectiveRoleHasAny(role, INTERNAL_ORDER_LAUNCH_ROLES);
}
