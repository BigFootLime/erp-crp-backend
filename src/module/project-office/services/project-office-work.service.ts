import { HttpError } from "../../../utils/httpError";
import {
  insertAuditLog,
  insertProjectActivity,
  isPgUniqueViolation,
  repoListActivity,
  withTransaction,
  type AuditContext,
} from "../repository/project-office.repository";
import {
  repoCreateComment,
  repoCreateDependency,
  repoCreateMilestone,
  repoCreateWorkPackage,
  repoDependencyPathExists,
  repoGetMilestoneById,
  repoGetWorkPackageById,
  repoListAllWorkPackages,
  repoListComments,
  repoListMilestones,
  repoListProjectDependencies,
  repoListWorkPackages,
  repoNextWorkPackageCode,
  repoPatchMilestone,
  repoPatchWorkPackage,
} from "../repository/project-office-work.repository";
import { repoCreateEvidence } from "../repository/project-office-registers.repository";
import type { Actor, WorkPackageRow } from "../types/project-office.types";
import type { CreateWorkPackageDTO, PatchWorkPackageDTO } from "../validators/project-office.validators";
import { requireProjectAccess } from "./project-office-access.service";

// Résout une tâche + l'accès projet de l'acteur (anti-IDOR : 404 si tâche d'un projet invisible).
export async function requireWorkPackage(actor: Actor, wpId: string, need: "read" | "write" = "read"): Promise<WorkPackageRow> {
  const wp = await repoGetWorkPackageById(wpId);
  if (!wp) throw new HttpError(404, "PO_WP_NOT_FOUND", "Tâche introuvable.");
  await requireProjectAccess(actor, wp.project_id, need);
  return wp;
}

export async function listWorkPackages(actor: Actor, opts: Parameters<typeof repoListWorkPackages>[0]) {
  await requireProjectAccess(actor, opts.project_id, "read");
  return repoListWorkPackages(opts);
}

export async function createWorkPackage(actor: Actor, input: CreateWorkPackageDTO, audit: AuditContext): Promise<WorkPackageRow> {
  await requireProjectAccess(actor, input.project_id, "write");
  if (input.parent_id) {
    const parent = await repoGetWorkPackageById(input.parent_id);
    if (!parent || parent.project_id !== input.project_id) {
      throw new HttpError(400, "PO_WP_BAD_PARENT", "Tâche parente invalide pour ce projet.");
    }
  }
  if (input.start_date && input.due_date && input.due_date < input.start_date) {
    throw new HttpError(400, "PO_WP_BAD_DATES", "L'échéance précède le début.");
  }
  // Retry court sur collision de code (numérotation concourante).
  const explicitCode = input.code?.trim().toUpperCase();
  const attempts = explicitCode ? 1 : 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await withTransaction(async (tx) => {
        const code = explicitCode ?? await repoNextWorkPackageCode(tx, input.project_id);
        const wp = await repoCreateWorkPackage(tx, {
          project_id: input.project_id,
          parent_id: input.parent_id ?? null,
          code,
          title: input.title,
          description: input.description ?? null,
          type: input.type,
          status: input.status,
          priority: input.priority,
          assignee_id: input.assignee_id ?? null,
          reporter_id: actor.id,
          start_date: input.start_date ?? null,
          due_date: input.due_date ?? null,
          estimated_hours: input.estimated_hours ?? null,
        });
        await insertProjectActivity(tx, {
          project_id: wp.project_id, entity_type: "work_package", entity_id: wp.id, action: "create",
          actor_id: actor.id, after_json: { code: wp.code, title: wp.title, status: wp.status },
        });
        await insertAuditLog(tx, audit, {
          action: "project-office.work-package.create", entity_type: "project_work_packages", entity_id: wp.id,
          details: { project_id: wp.project_id, code: wp.code },
        });
        return wp;
      });
    } catch (err) {
      if (isPgUniqueViolation(err) && explicitCode) {
        throw new HttpError(409, "PO_WP_CODE_TAKEN", "Ce code de tâche existe déjà dans le projet.");
      }
      if (!isPgUniqueViolation(err) || attempt === attempts - 1) throw err;
    }
  }
  throw new HttpError(500, "PO_WP_CODE_RACE", "Impossible d'attribuer un code de tâche.");
}

export async function patchWorkPackage(actor: Actor, wpId: string, patch: PatchWorkPackageDTO, audit: AuditContext): Promise<WorkPackageRow> {
  const before = await requireWorkPackage(actor, wpId, "write");
  if (patch.parent_id) {
    if (patch.parent_id === wpId) throw new HttpError(400, "PO_WP_SELF_PARENT", "Une tâche ne peut pas être son propre parent.");
    const parent = await repoGetWorkPackageById(patch.parent_id);
    if (!parent || parent.project_id !== before.project_id) {
      throw new HttpError(400, "PO_WP_BAD_PARENT", "Tâche parente invalide pour ce projet.");
    }
    const byId = new Map((await repoListAllWorkPackages(before.project_id)).map((wp) => [wp.id, wp]));
    const visited = new Set<string>();
    let cursor: string | null = patch.parent_id;
    while (cursor) {
      if (cursor === wpId) {
        throw new HttpError(409, "PO_WP_PARENT_CYCLE", "Cette hiérarchie de tâches créerait un cycle.");
      }
      if (visited.has(cursor)) break;
      visited.add(cursor);
      cursor = byId.get(cursor)?.parent_id ?? null;
    }
  }
  const nextStart = patch.start_date !== undefined ? patch.start_date : before.start_date;
  const nextDue = patch.due_date !== undefined ? patch.due_date : before.due_date;
  if (nextStart && nextDue && nextDue < nextStart) {
    throw new HttpError(400, "PO_WP_BAD_DATES", "L'échéance précède le début.");
  }
  // DONE ⇒ avancement 100 % (cohérence Kanban/Gantt).
  const effective: Record<string, unknown> = { ...patch };
  if (patch.status === "DONE" && patch.progress_percent === undefined) effective.progress_percent = 100;
  return withTransaction(async (tx) => {
    const wp = await repoPatchWorkPackage(tx, wpId, effective);
    if (!wp) throw new HttpError(404, "PO_WP_NOT_FOUND", "Tâche introuvable.");
    const changed = Object.keys(patch);
    await insertProjectActivity(tx, {
      project_id: wp.project_id, entity_type: "work_package", entity_id: wp.id, action: "update",
      actor_id: actor.id,
      before_json: Object.fromEntries(changed.map((k) => [k, (before as unknown as Record<string, unknown>)[k] ?? null])),
      after_json: Object.fromEntries(changed.map((k) => [k, (patch as Record<string, unknown>)[k]])),
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.work-package.update", entity_type: "project_work_packages", entity_id: wp.id,
      details: { project_id: wp.project_id, fields: changed },
    });
    return wp;
  });
}

export async function getWorkPackageDetail(actor: Actor, wpId: string) {
  const wp = await requireWorkPackage(actor, wpId, "read");
  const [comments, activity, dependencies] = await Promise.all([
    repoListComments(wpId),
    repoListActivity({ entity_type: "work_package", entity_id: wpId, limit: 50 }),
    repoListProjectDependencies(wp.project_id).then((deps) =>
      deps.filter((d) => d.source_work_package_id === wpId || d.target_work_package_id === wpId)
    ),
  ]);
  return { work_package: wp, comments, activity, dependencies };
}

export async function addComment(actor: Actor, wpId: string, body: string, audit: AuditContext) {
  const wp = await requireWorkPackage(actor, wpId, "write");
  return withTransaction(async (tx) => {
    const comment = await repoCreateComment(tx, { work_package_id: wpId, author_id: actor.id, body_markdown: body });
    await insertProjectActivity(tx, {
      project_id: wp.project_id, entity_type: "work_package", entity_id: wpId, action: "comment",
      actor_id: actor.id, after_json: { comment_id: comment.id },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.comment.create", entity_type: "project_comments", entity_id: comment.id,
      details: { work_package_id: wpId },
    });
    return comment;
  });
}

export async function addDependency(
  actor: Actor,
  sourceWpId: string,
  input: { target_work_package_id: string; dependency_type: string },
  audit: AuditContext
) {
  const source = await requireWorkPackage(actor, sourceWpId, "write");
  if (input.target_work_package_id === sourceWpId) {
    throw new HttpError(400, "PO_DEP_SELF", "Une tâche ne peut pas dépendre d'elle-même.");
  }
  const target = await repoGetWorkPackageById(input.target_work_package_id);
  if (!target || target.project_id !== source.project_id) {
    throw new HttpError(400, "PO_DEP_CROSS_PROJECT", "La dépendance doit rester dans le même projet.");
  }
  if (["BLOCKS", "REQUIRES"].includes(input.dependency_type)) {
    // Cycle : refuse si le graphe contient déjà un chemin target →…→ source.
    const cycle = await repoDependencyPathExists(input.target_work_package_id, sourceWpId);
    if (cycle) throw new HttpError(409, "PO_DEP_CYCLE", "Cette dépendance créerait un cycle.");
  }
  try {
    return await withTransaction(async (tx) => {
      const dep = await repoCreateDependency(tx, {
        source_work_package_id: sourceWpId,
        target_work_package_id: input.target_work_package_id,
        dependency_type: input.dependency_type,
      });
      await insertProjectActivity(tx, {
        project_id: source.project_id, entity_type: "dependency", entity_id: dep.id, action: "create",
        actor_id: actor.id, after_json: { source: source.code, target: target.code, type: input.dependency_type },
      });
      await insertAuditLog(tx, audit, {
        action: "project-office.dependency.create", entity_type: "project_dependencies", entity_id: dep.id,
        details: { project_id: source.project_id },
      });
      return dep;
    });
  } catch (err) {
    if (isPgUniqueViolation(err)) throw new HttpError(409, "PO_DEP_DUPLICATE", "Cette dépendance existe déjà.");
    throw err;
  }
}

export async function addEvidenceToWorkPackage(
  actor: Actor,
  wpId: string,
  input: { type: string; title: string; url: string | null; description: string | null },
  audit: AuditContext
) {
  const wp = await requireWorkPackage(actor, wpId, "write");
  return withTransaction(async (tx) => {
    const evidence = await repoCreateEvidence(tx, {
      project_id: wp.project_id, work_package_id: wpId, type: input.type,
      title: input.title, url: input.url, description: input.description, created_by: actor.id,
    });
    await insertProjectActivity(tx, {
      project_id: wp.project_id, entity_type: "evidence", entity_id: evidence.id, action: "create",
      actor_id: actor.id, after_json: { work_package_id: wpId, type: input.type, title: input.title },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.evidence.create", entity_type: "project_evidence", entity_id: evidence.id,
      details: { project_id: wp.project_id, work_package_id: wpId },
    });
    return evidence;
  });
}

// -------------------------------------------------------------- Vues planning
export async function getGanttData(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  const [workPackages, milestones, dependencies] = await Promise.all([
    repoListAllWorkPackages(projectId),
    repoListMilestones(projectId),
    repoListProjectDependencies(projectId),
  ]);
  return { work_packages: workPackages, milestones, dependencies };
}

export async function getKanbanData(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  const workPackages = await repoListAllWorkPackages(projectId);
  return { work_packages: workPackages };
}

export async function listMilestones(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  return repoListMilestones(projectId);
}

export async function createMilestone(
  actor: Actor,
  projectId: string,
  input: { name: string; description: string | null; due_date: string | null },
  audit: AuditContext
) {
  await requireProjectAccess(actor, projectId, "write");
  return withTransaction(async (tx) => {
    const milestone = await repoCreateMilestone(tx, { project_id: projectId, ...input });
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "milestone", entity_id: milestone.id, action: "create",
      actor_id: actor.id, after_json: { name: milestone.name, due_date: milestone.due_date },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.milestone.create", entity_type: "project_milestones", entity_id: milestone.id,
      details: { project_id: projectId },
    });
    return milestone;
  });
}

export async function patchMilestone(actor: Actor, milestoneId: string, patch: Record<string, unknown>, audit: AuditContext) {
  const before = await repoGetMilestoneById(milestoneId);
  if (!before) throw new HttpError(404, "PO_MILESTONE_NOT_FOUND", "Jalon introuvable.");
  await requireProjectAccess(actor, before.project_id, "write");
  return withTransaction(async (tx) => {
    const milestone = await repoPatchMilestone(tx, milestoneId, patch);
    if (!milestone) throw new HttpError(404, "PO_MILESTONE_NOT_FOUND", "Jalon introuvable.");
    const changed = Object.keys(patch);
    await insertProjectActivity(tx, {
      project_id: before.project_id, entity_type: "milestone", entity_id: milestoneId, action: "update",
      actor_id: actor.id,
      before_json: Object.fromEntries(changed.map((k) => [k, (before as unknown as Record<string, unknown>)[k] ?? null])),
      after_json: patch,
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.milestone.update", entity_type: "project_milestones", entity_id: milestoneId,
      details: { project_id: before.project_id, fields: changed },
    });
    return milestone;
  });
}
