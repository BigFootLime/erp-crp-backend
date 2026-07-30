import { effectiveRoleHasAny } from "../auth/domain/roles";
import { hasGrantedAccountModuleAccess } from "../access-control/context/account-module-access.context";

/**
 * RBAC clients — rôles existants uniquement (contrainte users_role_check,
 * db/patches/20260710_hr_users_role_responsable_rh.sql). Deny by default :
 * toute lecture exige un utilisateur authentifié ; les écritures et la
 * consultation des données financières complètes (IBAN en clair) sont
 * réservées aux rôles qui gèrent le référentiel clients.
 */
export const CLIENT_WRITE_ROLES = [
  "Directeur",
  "Administrateur Systeme et Reseau",
  "Secretaire",
  "Commercial",
] as const;

/**
 * Matrice données sensibles (docs frontend erp-core-completion-and-sensitive-data) :
 * IBAN/BIC = critique, masqué par défaut, complet uniquement pour compta/admin.
 * Faute de rôle comptabilité dédié, ce sont les rôles de gestion clients.
 */
export const CLIENT_FINANCE_ROLES = [
  "Directeur",
  "Administrateur Systeme et Reseau",
  "Secretaire",
  "Comptabilite",
] as const;

export function canViewClientFinance(role: string | undefined | null): boolean {
  if (hasGrantedAccountModuleAccess()) return true;
  return effectiveRoleHasAny(role, CLIENT_FINANCE_ROLES);
}

/** Keep the last 4 characters visible: enough to recognise the account, useless to replay. */
export function maskIban(iban: string | null | undefined): string | null {
  if (typeof iban !== "string") return null;
  const compact = iban.replace(/\s+/g, "");
  if (compact.length === 0) return null;
  if (compact.length <= 4) return "••••";
  return `••••${compact.slice(-4)}`;
}
