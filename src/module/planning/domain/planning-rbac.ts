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
  return PLANNING_ACCESS_ROLES.has(normalizeRole(role));
}

export function roleCanForcePlanningOverlap(role: string | null | undefined): boolean {
  return FORCE_OVERLAP_ROLES.has(normalizeRole(role));
}
