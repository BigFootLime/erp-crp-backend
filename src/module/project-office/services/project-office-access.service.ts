import { HttpError } from "../../../utils/httpError";
import {
  PROJECT_OFFICE_FLAG_KEY,
  repoGetProjectAccess,
  repoResolveFeatureAccess,
} from "../repository/project-office.repository";
import type { Actor, PoMemberRole, ProjectAccess } from "../types/project-office.types";

// Accès au module : feature flag fail-closed (flag absent/OFF ⇒ false), override par utilisateur.
export async function hasProjectOfficeAccess(userId: number): Promise<boolean> {
  return repoResolveFeatureAccess(PROJECT_OFFICE_FLAG_KEY, userId);
}

export async function assertProjectOfficeAccess(userId: number): Promise<void> {
  const ok = await hasProjectOfficeAccess(userId);
  // 403 contrôlé et non bavard : on ne dit pas pourquoi (flag), on ne liste rien.
  if (!ok) throw new HttpError(403, "PO_FORBIDDEN", "Accès refusé.");
}

const WRITE_ROLES: PoMemberRole[] = ["OWNER", "MANAGER", "CONTRIBUTOR"];
const MANAGE_ROLES: PoMemberRole[] = ["OWNER", "MANAGER"];

export function canWrite(access: ProjectAccess): boolean {
  return access.effective_role !== null && WRITE_ROLES.includes(access.effective_role);
}

export function canManage(access: ProjectAccess): boolean {
  return access.effective_role !== null && MANAGE_ROLES.includes(access.effective_role);
}

// Anti-IDOR : résout l'accès projet de l'acteur. Projet inexistant OU invisible ⇒ 404 contrôlé
// (pas de fuite d'existence). `need` élève ensuite en 403 si le rôle est insuffisant.
export async function requireProjectAccess(
  actor: Actor,
  projectId: string,
  need: "read" | "write" | "manage" = "read"
): Promise<ProjectAccess> {
  const access = await repoGetProjectAccess(projectId, actor.id);
  if (!access) throw new HttpError(404, "PO_PROJECT_NOT_FOUND", "Projet introuvable.");
  if (need === "write" && !canWrite(access)) {
    throw new HttpError(403, "PO_PROJECT_READ_ONLY", "Droits insuffisants sur ce projet (écriture).");
  }
  if (need === "manage" && !canManage(access)) {
    throw new HttpError(403, "PO_PROJECT_NOT_MANAGER", "Droits insuffisants sur ce projet (gestion).");
  }
  return access;
}
