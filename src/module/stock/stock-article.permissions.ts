export const ARTICLE_WRITE_ROLES = [
  "Directeur",
  "Administrateur Systeme et Reseau",
  "Secretaire",
  "Responsable Programmation",
  "Responsable Qualité",
] as const;

export const ARTICLE_ARCHIVE_ROLES = [
  "Directeur",
  "Administrateur Systeme et Reseau",
] as const;

export const ARTICLE_DOCUMENT_WRITE_ROLES = ARTICLE_WRITE_ROLES;

export const ARTICLE_COST_ROLES = [
  "Directeur",
  "Administrateur Systeme et Reseau",
  "Secretaire",
] as const;

export function canViewArticleCosts(role: string | null | undefined): boolean {
  return typeof role === "string" && (ARTICLE_COST_ROLES as readonly string[]).includes(role);
}
