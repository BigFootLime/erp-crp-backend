import { effectiveRoleParts } from "../../auth/domain/roles";

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

export function roleHasPlanningAccess(role: string | null | undefined): boolean {
  if (hasGrantedAccountModuleAccess()) return true;
  return effectiveRoleParts(role).some((part) => PLANNING_ACCESS_ROLES.has(normalizeRole(part)));
}

export function roleCanForcePlanningOverlap(role: string | null | undefined): boolean {
  if (hasGrantedAccountModuleAccess()) return true;
  return effectiveRoleParts(role).some((part) => FORCE_OVERLAP_ROLES.has(normalizeRole(part)));
}
import { hasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
