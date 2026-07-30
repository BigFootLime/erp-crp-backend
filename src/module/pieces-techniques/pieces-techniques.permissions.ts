/**
 * RBAC du module Données techniques (pièces techniques, versions, gammes, exigences
 * documentaires) — issue #227.
 *
 * POURQUOI CE FICHIER EXISTE
 * Les routes utilisaient `role.toLowerCase().includes("admin")`. Sur les sept rôles
 * principaux autorisés par `users_role_check`, cette approximation ne laissait passer que
 * « Administrateur Systeme et Reseau » : un Directeur, un Responsable Qualité ou un
 * Responsable Programmation recevait « Accès interdit » en validant l'indice d'une pièce.
 * Symétriquement, tout futur rôle contenant la sous-chaîne « admin » aurait franchi le
 * contrôle sans qu'aucune décision ne soit prise, et le multi-rôles #315 (`req.user.roles`)
 * était purement et simplement ignoré.
 *
 * On remplace la sous-chaîne par des listes nommées passées à `authorizeRole`, qui compare
 * les rôles RÉELLEMENT assignés (rôle principal + rôles d'organigramme). Le contrôle
 * devient explicite, énuméré et testable ; deny by default reste la règle.
 *
 * Ce fichier ne remplace PAS le gate d'accès module (#326) monté globalement dans
 * v1.routes.ts : celui-ci décide si l'utilisateur voit le module, les listes ci-dessous
 * décident de l'ACTE. Les deux s'appliquent, dans cet ordre.
 *
 * Référentiel des noms : src/module/auth/domain/roles.ts
 *   PRIMARY_USER_ROLES (contrainte DB users_role_check) + ORGANIZATION_USER_ROLES (#315).
 * Les deux familles sont énumérées ici parce qu'`authorizeRole` compare les noms assignés,
 * pas les alias d'autorisation.
 */

import type { Request } from "express";

import { hasGrantedAccountModuleAccess } from "../access-control/context/account-module-access.context";
import { effectiveRoleHasAny, hasAnyAssignedRole } from "../auth/domain/roles";

/**
 * Rédaction du dossier technique : créer/modifier une pièce, sa nomenclature, sa gamme,
 * ses documents. Ce sont les métiers du bureau d'études et des méthodes.
 */
export const PIECE_TECHNIQUE_WRITE_ROLES = [
  "Directeur",
  "Gérant",
  "Administrateur Systeme et Reseau",
  "Directeur Technique",
  "Responsable Programmation",
  "Programmation",
  "Études-Méthodes",
  "Responsable CAO",
  "Method",
  "Responsable Qualité",
  "Qualité",
] as const;

/**
 * Validation d'un indice (BROUILLON → EN_VALIDATION → APPLICABLE) et gel des exigences
 * documentaires. Acte d'engagement qualité : direction, qualité et méthodes. C'est le
 * défaut corrigé par #227 — auparavant seul l'administrateur système passait, alors qu'il
 * n'a aucune légitimité métier pour rendre un indice applicable.
 */
export const PIECE_TECHNIQUE_VALIDATE_ROLES = [
  "Directeur",
  "Gérant",
  "Administrateur Systeme et Reseau",
  "Directeur Technique",
  "Responsable Qualité",
  "Qualité",
  "Responsable Programmation",
  "Études-Méthodes",
  "Method",
] as const;

/**
 * Définition de la politique documentaire d'un client et du référentiel de types.
 * Décision qualité engageante, volontairement plus étroite que l'écriture courante :
 * elle conditionne ce qu'on devra prouver à la livraison.
 */
export const PIECE_DOCUMENT_POLICY_ROLES = [
  "Directeur",
  "Gérant",
  "Administrateur Systeme et Reseau",
  "Responsable Qualité",
  "Qualité",
] as const;

/**
 * Suppression d'une pièce technique — périmètre le plus étroit, la donnée technique est
 * une trace industrielle. La liste inclut explicitement le Directeur : la comparaison par
 * sous-chaîne l'en excluait par accident, ce qui n'a jamais été une décision.
 */
export const PIECE_TECHNIQUE_DELETE_ROLES = [
  "Directeur",
  "Gérant",
  "Administrateur Systeme et Reseau",
] as const;

type RoleBearer = Pick<NonNullable<Request["user"]>, "role"> & { roles?: string[] };

function allows(user: RoleBearer | null | undefined, allowed: readonly string[]): boolean {
  if (!user) return false;
  if (hasGrantedAccountModuleAccess()) return true;
  // Comparaison exacte sur les rôles assignés, jamais une sous-chaîne :
  // un rôle inconnu est refusé, point.
  return (
    hasAnyAssignedRole(user.role, user.roles, allowed) ||
    effectiveRoleHasAny(user.role, allowed)
  );
}

export const canWritePieceTechnique = (user: RoleBearer | null | undefined): boolean =>
  allows(user, PIECE_TECHNIQUE_WRITE_ROLES);

export const canValidatePieceTechnique = (user: RoleBearer | null | undefined): boolean =>
  allows(user, PIECE_TECHNIQUE_VALIDATE_ROLES);

export const canManageDocumentPolicy = (user: RoleBearer | null | undefined): boolean =>
  allows(user, PIECE_DOCUMENT_POLICY_ROLES);

export const canDeletePieceTechnique = (user: RoleBearer | null | undefined): boolean =>
  allows(user, PIECE_TECHNIQUE_DELETE_ROLES);

/**
 * Capacités renvoyées à l'UI. Elle masque ce qui est refusé pour ne pas promettre un acte
 * impossible ; le serveur refuse de toute façon. Masquer n'est jamais une autorisation.
 */
export type PieceTechniquePermissions = {
  can_write: boolean;
  can_validate: boolean;
  can_manage_document_policy: boolean;
  can_delete: boolean;
};

export function describePieceTechniquePermissions(
  user: RoleBearer | null | undefined
): PieceTechniquePermissions {
  return {
    can_write: canWritePieceTechnique(user),
    can_validate: canValidatePieceTechnique(user),
    can_manage_document_policy: canManageDocumentPolicy(user),
    can_delete: canDeletePieceTechnique(user),
  };
}
