import { effectiveRoleHasAny } from "../../auth/domain/roles";
import type { CommandeResponsibleRole } from "../workflow/commande-client-workflow.definition";

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

const WORKFLOW_OVERRIDE_ROLES = [
  "Administrateur Systeme et Reseau",
  "Directeur",
] as const;

const WORKFLOW_ROLES: Record<CommandeResponsibleRole, readonly string[]> = {
  secretariat: ["Secretaire", "Commercial", "Comptabilite"],
  technique: ["Method", "Responsable Programmation", "Production", "Responsable Production"],
  planning: ["Planification", "Production", "Responsable Programmation", "Responsable Production"],
  production: ["Production", "Atelier", "Opérateur atelier", "Responsable Production", "Responsable Atelier"],
  qualite: ["Responsable Qualité", "Qualité"],
  logistique: ["Logistique", "Stock", "Magasin"],
  comptabilite: ["Comptabilite"],
  direction: ["Directeur"],
};

export function canActOnCommandeWorkflowCheckpoint(params: {
  user_id: number;
  user_role: string | null | undefined;
  responsible_role: string;
  assigned_user_id?: number | null;
}): boolean {
  if (effectiveRoleHasAny(params.user_role, WORKFLOW_OVERRIDE_ROLES)) return true;
  if (params.assigned_user_id !== null && params.assigned_user_id !== undefined) {
    return params.assigned_user_id === params.user_id;
  }
  const allowed = WORKFLOW_ROLES[params.responsible_role as CommandeResponsibleRole];
  return allowed ? effectiveRoleHasAny(params.user_role, allowed) : false;
}
