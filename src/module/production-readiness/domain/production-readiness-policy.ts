import { hasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { effectiveRoleParts } from "../../auth/domain/roles";
import { roleHasMethodesCapability } from "../../methodes/domain/methodes-policy";

export const PRODUCTION_READINESS_CAPABILITIES = ["view", "calendar_write"] as const;
export type ProductionReadinessCapability = (typeof PRODUCTION_READINESS_CAPABILITIES)[number];

function normalizeRole(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s_-]+/g, "");
}
const READ_ROLES = new Set([
  "admin",
  "administrateur",
  "administrateursystemeetreseau",
  "directeur",
  "production",
  "responsableproduction",
  "responsableprogrammation",
  "planning",
  "planification",
  "atelier",
  "responsableatelier",
  "chefatelier",
  "operateuratelier",
  "method",
  "methodes",
]);

const CALENDAR_WRITE_ROLES = new Set([
  "admin",
  "administrateur",
  "administrateursystemeetreseau",
  "directeur",
  "responsableproduction",
  "responsableprogrammation",
  "planning",
  "planification",
]);

export function roleHasProductionReadinessCapability(
  role: string | null | undefined,
  capability: ProductionReadinessCapability
): boolean {
  if (hasGrantedAccountModuleAccess()) return true;
  const allowed = capability === "calendar_write" ? CALENDAR_WRITE_ROLES : READ_ROLES;
  return effectiveRoleParts(role).some((part) => allowed.has(normalizeRole(part)));
}

export function productionReadinessCapabilitiesFor(role: string | null | undefined) {
  return {
    view: roleHasProductionReadinessCapability(role, "view"),
    calendar_write: roleHasProductionReadinessCapability(role, "calendar_write"),
    cost_center_write: roleHasMethodesCapability(role, "referentiel_write"),
    rate_write: roleHasMethodesCapability(role, "tarif_write"),
  };
}
