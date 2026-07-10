import { HttpError } from "../../../utils/httpError";
import {
  insertAuditLog,
  insertProjectActivity,
  isPgUniqueViolation,
  withTransaction,
  type AuditContext,
} from "../repository/project-office.repository";
import {
  repoApproveSpecVersion,
  repoCreateAction,
  repoCreateDecision,
  repoCreateEvidence,
  repoCreateExternalLink,
  repoCreateRisk,
  repoCreateSpec,
  repoCreateSpecVersion,
  repoGetActionById,
  repoGetEvidenceById,
  repoGetRiskById,
  repoGetSpecById,
  repoGetSpecVersionById,
  repoListActions,
  repoListDecisions,
  repoListEvidence,
  repoListExternalLinks,
  repoListRisks,
  repoListSpecs,
  repoListSpecVersions,
  repoPatchAction,
  repoPatchRisk,
  repoSetSpecStatus,
} from "../repository/project-office-registers.repository";
import type { Actor, SpecRow } from "../types/project-office.types";
import { requireProjectAccess } from "./project-office-access.service";

// -------------------------------------------------------------- Cahier des charges versionné
export async function listSpecs(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  return repoListSpecs(projectId);
}

export async function requireSpec(actor: Actor, specId: string, need: "read" | "write" | "manage" = "read"): Promise<SpecRow> {
  const spec = await repoGetSpecById(specId);
  if (!spec) throw new HttpError(404, "PO_SPEC_NOT_FOUND", "Cahier des charges introuvable.");
  await requireProjectAccess(actor, spec.project_id, need);
  return spec;
}

export async function createSpec(
  actor: Actor,
  projectId: string,
  input: { title: string; content_markdown?: string },
  audit: AuditContext
) {
  await requireProjectAccess(actor, projectId, "write");
  return withTransaction(async (tx) => {
    const spec = await repoCreateSpec(tx, { project_id: projectId, title: input.title });
    let version = null;
    if (input.content_markdown) {
      version = await repoCreateSpecVersion(tx, {
        spec_id: spec.id, version: "1.0", content_markdown: input.content_markdown,
        change_summary: "Version initiale", author_id: actor.id,
      });
    }
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "spec", entity_id: spec.id, action: "create",
      actor_id: actor.id, after_json: { title: spec.title, initial_version: version?.version ?? null },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.spec.create", entity_type: "project_specs", entity_id: spec.id,
      details: { project_id: projectId },
    });
    return { ...spec, current_version_id: version?.id ?? null, current_version: version?.version ?? null };
  });
}

export async function getSpecDetail(actor: Actor, specId: string) {
  const spec = await requireSpec(actor, specId, "read");
  const versions = await repoListSpecVersions(specId);
  return { spec, versions };
}

export async function createSpecVersion(
  actor: Actor,
  specId: string,
  input: { version: string; content_markdown: string; change_summary?: string | null },
  audit: AuditContext
) {
  const spec = await requireSpec(actor, specId, "write");
  try {
    return await withTransaction(async (tx) => {
      const version = await repoCreateSpecVersion(tx, {
        spec_id: specId, version: input.version, content_markdown: input.content_markdown,
        change_summary: input.change_summary ?? null, author_id: actor.id,
      });
      // Une spec APPROVED est FIGÉE : une nouvelle version la remet en travail (DRAFT).
      if (spec.status === "APPROVED" || spec.status === "REVIEW") {
        await repoSetSpecStatus(tx, specId, "DRAFT");
      }
      await insertProjectActivity(tx, {
        project_id: spec.project_id, entity_type: "spec", entity_id: specId, action: "new_version",
        actor_id: actor.id, after_json: { version: input.version, change_summary: input.change_summary ?? null },
      });
      await insertAuditLog(tx, audit, {
        action: "project-office.spec.version.create", entity_type: "project_spec_versions", entity_id: version.id,
        details: { spec_id: specId, version: input.version },
      });
      return version;
    });
  } catch (err) {
    if (isPgUniqueViolation(err)) throw new HttpError(409, "PO_SPEC_VERSION_TAKEN", "Cette version existe déjà pour ce cahier des charges.");
    throw err;
  }
}

export async function patchSpecStatus(actor: Actor, specId: string, status: "DRAFT" | "REVIEW" | "OBSOLETE", audit: AuditContext) {
  const spec = await requireSpec(actor, specId, "write");
  if (status === "REVIEW" && !spec.current_version_id) {
    throw new HttpError(409, "PO_SPEC_NO_VERSION", "Impossible de passer en relecture sans version.");
  }
  await withTransaction(async (tx) => {
    await repoSetSpecStatus(tx, specId, status);
    await insertProjectActivity(tx, {
      project_id: spec.project_id, entity_type: "spec", entity_id: specId, action: "status",
      actor_id: actor.id, before_json: { status: spec.status }, after_json: { status },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.spec.status", entity_type: "project_specs", entity_id: specId,
      details: { from: spec.status, to: status },
    });
  });
  return { ...spec, status };
}

export async function approveSpec(actor: Actor, specId: string, audit: AuditContext) {
  // Approbation = MANAGER+ du projet, et JAMAIS l'auteur de la version courante (no-self-approve).
  const spec = await requireSpec(actor, specId, "manage");
  if (!spec.current_version_id) throw new HttpError(409, "PO_SPEC_NO_VERSION", "Aucune version à approuver.");
  const version = await repoGetSpecVersionById(spec.current_version_id);
  if (!version) throw new HttpError(409, "PO_SPEC_NO_VERSION", "Version courante introuvable.");
  if (version.author_id === actor.id) {
    throw new HttpError(403, "PO_SPEC_SELF_APPROVE", "L'auteur d'une version ne peut pas l'approuver lui-même.");
  }
  if (spec.status === "APPROVED" && version.approved_at) {
    throw new HttpError(409, "PO_SPEC_ALREADY_APPROVED", "Cette version est déjà approuvée.");
  }
  return withTransaction(async (tx) => {
    const approved = await repoApproveSpecVersion(tx, version.id, actor.id);
    if (!approved) throw new HttpError(409, "PO_SPEC_ALREADY_APPROVED", "Cette version est déjà approuvée.");
    await repoSetSpecStatus(tx, specId, "APPROVED");
    await insertProjectActivity(tx, {
      project_id: spec.project_id, entity_type: "spec", entity_id: specId, action: "approve",
      actor_id: actor.id, after_json: { version: approved.version, approved_by: actor.id },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.spec.approve", entity_type: "project_spec_versions", entity_id: approved.id,
      details: { spec_id: specId, version: approved.version },
    });
    return { spec: { ...spec, status: "APPROVED" as const }, version: approved };
  });
}

// -------------------------------------------------------------- Décisions
export async function listDecisions(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  return repoListDecisions(projectId);
}

export async function createDecision(
  actor: Actor,
  projectId: string,
  input: { title: string; context?: string | null; options_json?: unknown; decision: string; consequences?: string | null },
  audit: AuditContext
) {
  await requireProjectAccess(actor, projectId, "write");
  return withTransaction(async (tx) => {
    const decision = await repoCreateDecision(tx, {
      project_id: projectId, title: input.title, context: input.context ?? null,
      options_json: input.options_json ?? null, decision: input.decision,
      consequences: input.consequences ?? null, decided_by: actor.id,
    });
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "decision", entity_id: decision.id, action: "create",
      actor_id: actor.id, after_json: { title: input.title },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.decision.create", entity_type: "project_decisions", entity_id: decision.id,
      details: { project_id: projectId },
    });
    return decision;
  });
}

// -------------------------------------------------------------- Risques
export async function listRisks(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  return repoListRisks(projectId);
}

export async function createRisk(
  actor: Actor,
  projectId: string,
  input: { title: string; description?: string | null; probability: number; impact: number; mitigation?: string | null; owner_id?: number | null },
  audit: AuditContext
) {
  await requireProjectAccess(actor, projectId, "write");
  return withTransaction(async (tx) => {
    const risk = await repoCreateRisk(tx, {
      project_id: projectId, title: input.title, description: input.description ?? null,
      probability: input.probability, impact: input.impact,
      mitigation: input.mitigation ?? null, owner_id: input.owner_id ?? null,
    });
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "risk", entity_id: risk.id, action: "create",
      actor_id: actor.id, after_json: { title: input.title, severity: risk.severity },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.risk.create", entity_type: "project_risks", entity_id: risk.id,
      details: { project_id: projectId, severity: risk.severity },
    });
    return risk;
  });
}

export async function patchRisk(actor: Actor, riskId: string, patch: Record<string, unknown>, audit: AuditContext) {
  const before = await repoGetRiskById(riskId);
  if (!before) throw new HttpError(404, "PO_RISK_NOT_FOUND", "Risque introuvable.");
  await requireProjectAccess(actor, before.project_id, "write");
  return withTransaction(async (tx) => {
    const risk = await repoPatchRisk(tx, riskId, patch);
    if (!risk) throw new HttpError(404, "PO_RISK_NOT_FOUND", "Risque introuvable.");
    const changed = Object.keys(patch);
    await insertProjectActivity(tx, {
      project_id: before.project_id, entity_type: "risk", entity_id: riskId, action: "update",
      actor_id: actor.id,
      before_json: Object.fromEntries(changed.map((k) => [k, (before as unknown as Record<string, unknown>)[k] ?? null])),
      after_json: patch,
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.risk.update", entity_type: "project_risks", entity_id: riskId,
      details: { project_id: before.project_id, fields: changed },
    });
    return risk;
  });
}

// -------------------------------------------------------------- Actions correctives
export async function listActions(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  return repoListActions(projectId);
}

export async function createAction(
  actor: Actor,
  projectId: string,
  input: {
    source_type: string; title: string; description?: string | null; priority: string;
    owner_id?: number | null; due_date?: string | null; evidence_id?: string | null;
  },
  audit: AuditContext
) {
  await requireProjectAccess(actor, projectId, "write");
  if (input.evidence_id) {
    const ev = await repoGetEvidenceById(input.evidence_id);
    if (!ev || ev.project_id !== projectId) throw new HttpError(400, "PO_EVIDENCE_BAD_PROJECT", "Preuve invalide pour ce projet.");
  }
  return withTransaction(async (tx) => {
    const action = await repoCreateAction(tx, {
      project_id: projectId, source_type: input.source_type, title: input.title,
      description: input.description ?? null, priority: input.priority,
      owner_id: input.owner_id ?? null, due_date: input.due_date ?? null, evidence_id: input.evidence_id ?? null,
    });
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "action", entity_id: action.id, action: "create",
      actor_id: actor.id, after_json: { title: input.title, source_type: input.source_type },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.action.create", entity_type: "project_corrective_actions", entity_id: action.id,
      details: { project_id: projectId },
    });
    return action;
  });
}

export async function patchAction(actor: Actor, actionId: string, patch: Record<string, unknown>, audit: AuditContext) {
  const before = await repoGetActionById(actionId);
  if (!before) throw new HttpError(404, "PO_ACTION_NOT_FOUND", "Action introuvable.");
  await requireProjectAccess(actor, before.project_id, "write");
  if (patch.evidence_id) {
    const ev = await repoGetEvidenceById(String(patch.evidence_id));
    if (!ev || ev.project_id !== before.project_id) throw new HttpError(400, "PO_EVIDENCE_BAD_PROJECT", "Preuve invalide pour ce projet.");
  }
  return withTransaction(async (tx) => {
    const action = await repoPatchAction(tx, actionId, patch);
    if (!action) throw new HttpError(404, "PO_ACTION_NOT_FOUND", "Action introuvable.");
    const changed = Object.keys(patch);
    await insertProjectActivity(tx, {
      project_id: before.project_id, entity_type: "action", entity_id: actionId, action: "update",
      actor_id: actor.id,
      before_json: Object.fromEntries(changed.map((k) => [k, (before as unknown as Record<string, unknown>)[k] ?? null])),
      after_json: patch,
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.action.update", entity_type: "project_corrective_actions", entity_id: actionId,
      details: { project_id: before.project_id, fields: changed },
    });
    return action;
  });
}

// -------------------------------------------------------------- Preuves & liens externes
export async function listEvidence(actor: Actor, opts: { project_id: string; work_package_id?: string; page: number; pageSize: number }) {
  await requireProjectAccess(actor, opts.project_id, "read");
  return repoListEvidence(opts);
}

export async function createEvidence(
  actor: Actor,
  projectId: string,
  input: { work_package_id?: string | null; type: string; title: string; url?: string | null; description?: string | null },
  audit: AuditContext
) {
  await requireProjectAccess(actor, projectId, "write");
  return withTransaction(async (tx) => {
    const evidence = await repoCreateEvidence(tx, {
      project_id: projectId, work_package_id: input.work_package_id ?? null, type: input.type,
      title: input.title, url: input.url ?? null, description: input.description ?? null, created_by: actor.id,
    });
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "evidence", entity_id: evidence.id, action: "create",
      actor_id: actor.id, after_json: { type: input.type, title: input.title },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.evidence.create", entity_type: "project_evidence", entity_id: evidence.id,
      details: { project_id: projectId },
    });
    return evidence;
  });
}

export async function listExternalLinks(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  return repoListExternalLinks(projectId);
}

export async function createExternalLink(
  actor: Actor,
  input: {
    project_id: string; entity_type: string; entity_id?: string | null; provider: string;
    external_type: string; external_id?: string | null; url: string; status?: string | null;
  },
  audit: AuditContext
) {
  await requireProjectAccess(actor, input.project_id, "write");
  return withTransaction(async (tx) => {
    const link = await repoCreateExternalLink(tx, {
      project_id: input.project_id, entity_type: input.entity_type, entity_id: input.entity_id ?? null,
      provider: input.provider, external_type: input.external_type, external_id: input.external_id ?? null,
      url: input.url, status: input.status ?? null, created_by: actor.id,
    });
    await insertProjectActivity(tx, {
      project_id: input.project_id, entity_type: "external_link", entity_id: link.id, action: "create",
      actor_id: actor.id, after_json: { provider: input.provider, external_type: input.external_type, url: input.url },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.external-link.create", entity_type: "project_external_links", entity_id: link.id,
      details: { project_id: input.project_id, provider: input.provider },
    });
    return link;
  });
}
