import { effectiveRoleHasAny } from "../auth/domain/roles";
import { hasGrantedAccountModuleAccess } from "../access-control/context/account-module-access.context";

export const ARTICLE_WRITE_ROLES = [
  "Directeur",
  "Administrateur Systeme et Reseau",
  "Secretaire",
  "Responsable Programmation",
  "Responsable Qualité",
  // Explicit authorization aliases emitted for organization responsibilities.
  // They keep article master-data writes available to Methods, Purchasing and
  // Material Management without granting a global administrator role.
  "Method",
  "Achat",
  "Stock",
  "Magasin",
] as const;

export const ARTICLE_ARCHIVE_ROLES = [
  "Directeur",
  "Administrateur Systeme et Reseau",
] as const;

/** La création d'un brouillon et sa mise en production sont deux droits distincts. */
export const ARTICLE_APPROVE_ROLES = [
  "Directeur",
  "Administrateur Systeme et Reseau",
  "Responsable Programmation",
  "Responsable Qualité",
  "Method",
  "Achat",
] as const;

export const ARTICLE_DOCUMENT_WRITE_ROLES = ARTICLE_WRITE_ROLES;

export const ARTICLE_COST_ROLES = [
  "Directeur",
  "Administrateur Systeme et Reseau",
  "Secretaire",
  "Achat",
  "Comptabilite",
] as const;

export function canViewArticleCosts(role: string | null | undefined): boolean {
  if (hasGrantedAccountModuleAccess()) return true;
  return effectiveRoleHasAny(role, ARTICLE_COST_ROLES);
}
