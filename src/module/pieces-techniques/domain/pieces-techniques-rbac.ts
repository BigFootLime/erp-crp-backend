import { effectiveRoleHasAny } from "../../auth/domain/roles";
import { hasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";

/**
 * Releasing a technical definition is distinct from deleting one.
 *
 * The former belongs to Direction, Methods and Quality responsibilities; the
 * latter remains restricted to the historical administrator guard.
 */
export const PIECE_TECHNIQUE_VERSION_APPROVAL_ROLES = [
  "Directeur",
  "Administrateur Systeme et Reseau",
  "Responsable Programmation",
  "Responsable Qualité",
  "Method",
] as const;

export function canApprovePieceTechniqueVersion(
  role: string | null | undefined
): boolean {
  if (hasGrantedAccountModuleAccess()) return true;
  return effectiveRoleHasAny(role, PIECE_TECHNIQUE_VERSION_APPROVAL_ROLES);
}
