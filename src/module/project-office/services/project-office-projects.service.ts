import { HttpError } from "../../../utils/httpError";
import {
  insertAuditLog,
  insertProjectActivity,
  isPgUniqueViolation,
  repoCreateProject,
  repoDeleteMember,
  repoGetProjectById,
  repoListActivity,
  repoListMembers,
  repoListProjects,
  repoPatchProject,
  repoUpsertMember,
  repoUserExists,
  withTransaction,
  type AuditContext,
} from "../repository/project-office.repository";
import { repoGetProjectStats } from "../repository/project-office-report.repository";
import { repoListMilestones } from "../repository/project-office-work.repository";
import type { Actor, PoMemberRole, ProjectRow } from "../types/project-office.types";
import type { CreateProjectDTO, PatchProjectDTO } from "../validators/project-office.validators";
import { requireProjectAccess } from "./project-office-access.service";

export async function listProjects(
  actor: Actor,
  opts: { q?: string; status?: string; page: number; pageSize: number }
) {
  return repoListProjects(actor.id, opts);
}

export async function createProject(actor: Actor, input: CreateProjectDTO, audit: AuditContext): Promise<ProjectRow> {
  try {
    return await withTransaction(async (tx) => {
      const project = await repoCreateProject(tx, {
        code: input.code.toUpperCase(),
        name: input.name,
        description: input.description ?? null,
        owner_id: actor.id, // le créateur est propriétaire — jamais pris du body (anti-spoof)
        visibility: input.visibility,
        status: input.status,
        start_date: input.start_date ?? null,
        target_date: input.target_date ?? null,
      });
      await insertProjectActivity(tx, {
        project_id: project.id, entity_type: "project", entity_id: project.id,
        action: "create", actor_id: actor.id, after_json: { code: project.code, name: project.name },
      });
      await insertAuditLog(tx, audit, {
        action: "project-office.project.create", entity_type: "project_projects", entity_id: project.id,
        details: { code: project.code },
      });
      return project;
    });
  } catch (err) {
    if (isPgUniqueViolation(err)) throw new HttpError(409, "PO_PROJECT_CODE_TAKEN", "Ce code projet existe déjà.");
    throw err;
  }
}

export async function getProjectDetail(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  const project = await repoGetProjectById(projectId);
  if (!project) throw new HttpError(404, "PO_PROJECT_NOT_FOUND", "Projet introuvable.");
  const [members, stats, milestones, activity] = await Promise.all([
    repoListMembers(projectId),
    repoGetProjectStats(projectId),
    repoListMilestones(projectId),
    repoListActivity({ project_id: projectId, limit: 20 }),
  ]);
  return { project, members, stats, milestones, activity };
}

export async function patchProject(actor: Actor, projectId: string, patch: PatchProjectDTO, audit: AuditContext): Promise<ProjectRow> {
  await requireProjectAccess(actor, projectId, "manage");
  const before = await repoGetProjectById(projectId);
  if (!before) throw new HttpError(404, "PO_PROJECT_NOT_FOUND", "Projet introuvable.");
  const updated = await withTransaction(async (tx) => {
    const row = await repoPatchProject(tx, projectId, patch);
    if (!row) throw new HttpError(404, "PO_PROJECT_NOT_FOUND", "Projet introuvable.");
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "project", entity_id: projectId, action: "update",
      actor_id: actor.id, before_json: diffOf(before as unknown as Record<string, unknown>, patch),
      after_json: patch,
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.project.update", entity_type: "project_projects", entity_id: projectId,
      details: { fields: Object.keys(patch) },
    });
    return row;
  });
  return updated;
}

// Extrait de l'état "avant" limité aux champs réellement modifiés (audit lisible).
function diffOf(before: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) out[k] = before[k] ?? null;
  return out;
}

export async function addMember(
  actor: Actor,
  projectId: string,
  input: { user_id: number; role: PoMemberRole },
  audit: AuditContext
) {
  const access = await requireProjectAccess(actor, projectId, "manage");
  if (input.role === "OWNER") throw new HttpError(400, "PO_MEMBER_OWNER_FIXED", "Le propriétaire est défini à la création du projet.");
  if (input.user_id === access.owner_id) throw new HttpError(409, "PO_MEMBER_IS_OWNER", "Cet utilisateur est déjà propriétaire du projet.");
  if (!(await repoUserExists(input.user_id))) throw new HttpError(404, "PO_USER_NOT_FOUND", "Utilisateur introuvable.");
  return withTransaction(async (tx) => {
    const member = await repoUpsertMember(tx, { project_id: projectId, user_id: input.user_id, role: input.role });
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "member", entity_id: member.id, action: "upsert",
      actor_id: actor.id, after_json: { user_id: input.user_id, role: input.role },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.member.upsert", entity_type: "project_members", entity_id: member.id,
      details: { project_id: projectId, member_user_id: input.user_id, role: input.role },
    });
    return member;
  });
}

export async function removeMember(actor: Actor, projectId: string, userId: number, audit: AuditContext) {
  const access = await requireProjectAccess(actor, projectId, "manage");
  if (userId === access.owner_id) throw new HttpError(409, "PO_MEMBER_IS_OWNER", "Impossible de retirer le propriétaire.");
  const removed = await withTransaction(async (tx) => {
    const ok = await repoDeleteMember(tx, projectId, userId);
    if (!ok) return false;
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "member", entity_id: null, action: "remove",
      actor_id: actor.id, before_json: { user_id: userId },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.member.remove", entity_type: "project_members", entity_id: null,
      details: { project_id: projectId, member_user_id: userId },
    });
    return true;
  });
  if (!removed) throw new HttpError(404, "PO_MEMBER_NOT_FOUND", "Membre introuvable sur ce projet.");
  return { removed: true };
}
