export const PRIMARY_USER_ROLES = [
  "Directeur",
  "Employee",
  "Administrateur Systeme et Reseau",
  "Responsable Qualité",
  "Secretaire",
  "Responsable Programmation",
  "Responsable RH",
] as const;

export const ORGANIZATION_USER_ROLES = [
  "Gérant",
  "Commerce",
  "Achats",
  "RH-Financier",
  "Directeur Technique",
  "Responsable Atelier-Production",
  "Planning",
  "Planification",
  "Préparateur commandes",
  "Assistante polyvalente",
  "Assistante RH",
  "Maintenance",
  "Responsable Agencement",
  "Qualité",
  "Études-Méthodes",
  "Programmation",
  "Fraisage",
  "Livraison",
  "Préparation matière",
  "Finitions",
  "Gestion matière",
  "Responsable CAO",
  "Responsable fabrication fraisage",
  "Tournage",
  "Responsable tournage",
  "Opérateur atelier",
] as const;

export const ASSIGNABLE_USER_ROLES = [
  ...PRIMARY_USER_ROLES,
  ...ORGANIZATION_USER_ROLES,
] as const;

export type PrimaryUserRole = (typeof PRIMARY_USER_ROLES)[number];
export type AssignableUserRole = (typeof ASSIGNABLE_USER_ROLES)[number];

/**
 * Les intitulés d'organigramme ne sont jamais interprétés directement comme
 * des privilèges. Chaque responsabilité est traduite ici vers des marqueurs
 * techniques déjà compris par les politiques métier historiques.
 *
 * Exemple important : « Directeur Technique » donne accès à la production et
 * aux méthodes, mais ne doit pas être confondu avec « Directeur » et ouvrir la
 * finance ou l'administration.
 */
const AUTHORIZATION_ALIASES: Record<AssignableUserRole, readonly string[]> = {
  Directeur: ["Directeur"],
  Employee: ["Employee"],
  "Administrateur Systeme et Reseau": ["Administrateur Systeme et Reseau"],
  "Responsable Qualité": ["Responsable Qualité"],
  Secretaire: ["Secretaire"],
  "Responsable Programmation": ["Responsable Programmation"],
  "Responsable RH": ["Responsable RH"],
  Gérant: ["Directeur"],
  Commerce: ["Commercial"],
  Achats: ["Achat"],
  "RH-Financier": ["Responsable RH", "Comptabilite"],
  "Directeur Technique": ["Production", "Atelier", "Method"],
  "Responsable Atelier-Production": ["Production", "Atelier"],
  Planning: ["Planification"],
  Planification: ["Planification"],
  "Préparateur commandes": ["Logistique"],
  "Assistante polyvalente": ["Secretaire"],
  "Assistante RH": ["Responsable RH"],
  Maintenance: ["Maintenance", "Atelier"],
  "Responsable Agencement": ["Production", "Atelier"],
  Qualité: ["Responsable Qualité"],
  "Études-Méthodes": ["Method", "Responsable Programmation"],
  Programmation: ["Responsable Programmation"],
  Fraisage: ["Opérateur atelier"],
  Livraison: ["Logistique"],
  "Préparation matière": ["Stock", "Atelier"],
  Finitions: ["Opérateur atelier"],
  "Gestion matière": ["Stock", "Magasin"],
  "Responsable CAO": ["Method"],
  "Responsable fabrication fraisage": ["Production", "Atelier"],
  Tournage: ["Opérateur atelier"],
  "Responsable tournage": ["Production", "Atelier"],
  "Opérateur atelier": ["Opérateur atelier"],
};

export function normalizeAssignedRoles(
  primaryRole: string | null | undefined,
  roles: readonly string[] | null | undefined
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const role of [primaryRole, ...(roles ?? [])]) {
    const value = String(role ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

export function authorizationRole(
  primaryRole: string | null | undefined,
  roles: readonly string[] | null | undefined
): string {
  const aliases = normalizeAssignedRoles(primaryRole, roles).flatMap((role) => {
    return AUTHORIZATION_ALIASES[role as AssignableUserRole] ?? [];
  });
  return [...new Set(aliases)].join(" | ");
}

export function effectiveRoleParts(role: string | null | undefined): string[] {
  return String(role ?? "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function effectiveRoleHasAny(
  role: string | null | undefined,
  allowedRoles: readonly string[]
): boolean {
  const allowed = new Set(allowedRoles);
  return effectiveRoleParts(role).some((part) => allowed.has(part));
}

export function hasAnyAssignedRole(
  primaryRole: string | null | undefined,
  assignedRoles: readonly string[] | null | undefined,
  allowedRoles: readonly string[]
): boolean {
  const allowed = new Set(allowedRoles);
  return normalizeAssignedRoles(primaryRole, assignedRoles).some((role) => allowed.has(role));
}
