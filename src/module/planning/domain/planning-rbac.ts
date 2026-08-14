import { effectiveRoleParts } from "../../auth/domain/roles";
import { hasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";

function normalizeRole(role: string | null | undefined): string {
  return String(role ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s_-]+/g, "");
}

const PLANNING_ACCESS_ROLES = new Set([
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
  "operateuratelier",
  "responsableatelier",
  "chefatelier",
  "secretariat",
  "secretaire",
]);

const FORCE_OVERLAP_ROLES = new Set([
  "admin",
  "administrateur",
  "administrateursystemeetreseau",
  "directeur",
  "responsableproduction",
  "responsableatelier",
  "chefatelier",
]);

export type PlanningCapability =
  | "read"
  | "manage_schedule"
  | "read_capacity"
  | "manage_preferences"
  | "supervise_execution";

const PLANNING_MANAGE_ROLES = new Set([
  "admin",
  "administrateur",
  "administrateursystemeetreseau",
  "directeur",
  "production",
  "responsableproduction",
  "responsableprogrammation",
  "planning",
  "planification",
  "responsableatelier",
  "chefatelier",
]);

const PLANNING_CAPACITY_ROLES = new Set([
  ...PLANNING_MANAGE_ROLES,
  "responsableatelier",
  "chefatelier",
]);

const PLANNING_SUPERVISION_ROLES = new Set([
  "admin",
  "administrateur",
  "administrateursystemeetreseau",
  "directeur",
  "responsableproduction",
  "responsableatelier",
  "chefatelier",
]);

export function roleHasPlanningAccess(role: string | null | undefined): boolean {
  if (hasGrantedAccountModuleAccess()) return true;
  return effectiveRoleParts(role).some((part) => PLANNING_ACCESS_ROLES.has(normalizeRole(part)));
}

export function roleCanForcePlanningOverlap(role: string | null | undefined): boolean {
  // ADR-0049: an account-level module grant supersedes this legacy role fallback.
  if (hasGrantedAccountModuleAccess()) return true;
  return effectiveRoleParts(role).some((part) => FORCE_OVERLAP_ROLES.has(normalizeRole(part)));
}

export function roleHasPlanningCapability(
  role: string | null | undefined,
  capability: PlanningCapability
): boolean {
  const parts = effectiveRoleParts(role).map(normalizeRole);
  if (capability === "read" || capability === "manage_preferences") {
    return parts.some((part) => PLANNING_ACCESS_ROLES.has(part));
  }
  if (capability === "manage_schedule") {
    return parts.some((part) => PLANNING_MANAGE_ROLES.has(part));
  }
  if (capability === "read_capacity") {
    return parts.some((part) => PLANNING_CAPACITY_ROLES.has(part));
  }
  return parts.some((part) => PLANNING_SUPERVISION_ROLES.has(part));
}
