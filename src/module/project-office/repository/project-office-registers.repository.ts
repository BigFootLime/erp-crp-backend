import pool from "../../../config/database";
import type { DbQueryer } from "./project-office.repository";
import type {
  ActionRow,
  DecisionRow,
  EvidenceRow,
  ExternalLinkRow,
  RiskRow,
  SpecRow,
  SpecVersionRow,
} from "../types/project-office.types";

// -------------------------------------------------------------- Specs (cahier des charges versionné)
const SPEC_COLS = `s.id::text, s.project_id::text, s.title, s.status::text, s.current_version_id::text,
  v.version AS current_version, s.created_at::text, s.updated_at::text`;

function mapSpec(r: Record<string, unknown>): SpecRow {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    title: String(r.title),
    status: r.status as SpecRow["status"],
    current_version_id: (r.current_version_id as string | null) ?? null,
    current_version: (r.current_version as string | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

function mapSpecVersion(r: Record<string, unknown>): SpecVersionRow {
  return {
    id: String(r.id),
    spec_id: String(r.spec_id),
    version: String(r.version),
    content_markdown: String(r.content_markdown),
    change_summary: (r.change_summary as string | null) ?? null,
    author_id: Number(r.author_id),
    approved_by: r.approved_by === null || r.approved_by === undefined ? null : Number(r.approved_by),
    approved_at: (r.approved_at as string | null) ?? null,
    created_at: String(r.created_at),
  };
}

export async function repoListSpecs(projectId: string, q: DbQueryer = pool): Promise<SpecRow[]> {
  const res = await q.query(
    `SELECT ${SPEC_COLS} FROM public.project_specs s
      LEFT JOIN public.project_spec_versions v ON v.id = s.current_version_id
      WHERE s.project_id = $1::uuid ORDER BY s.created_at`,
    [projectId]
  );
  return res.rows.map(mapSpec);
}

export async function repoGetSpecById(id: string, q: DbQueryer = pool): Promise<SpecRow | null> {
  const res = await q.query(
    `SELECT ${SPEC_COLS} FROM public.project_specs s
      LEFT JOIN public.project_spec_versions v ON v.id = s.current_version_id
      WHERE s.id = $1::uuid LIMIT 1`,
    [id]
  );
  return res.rows[0] ? mapSpec(res.rows[0]) : null;
}

export async function repoCreateSpec(tx: DbQueryer, input: { project_id: string; title: string }): Promise<SpecRow> {
  const res = await tx.query(
    `INSERT INTO public.project_specs (project_id, title)
     VALUES ($1::uuid, $2)
     RETURNING id::text, project_id::text, title, status::text, current_version_id::text,
               NULL AS current_version, created_at::text, updated_at::text`,
    [input.project_id, input.title]
  );
  return mapSpec(res.rows[0]);
}

export async function repoSetSpecStatus(tx: DbQueryer, id: string, status: string): Promise<void> {
  await tx.query(
    `UPDATE public.project_specs SET status = $2::public.po_spec_status, updated_at = now() WHERE id = $1::uuid`,
    [id, status]
  );
}

export async function repoListSpecVersions(specId: string, q: DbQueryer = pool): Promise<SpecVersionRow[]> {
  const res = await q.query(
    `SELECT id::text, spec_id::text, version, content_markdown, change_summary, author_id,
            approved_by, approved_at::text, created_at::text
       FROM public.project_spec_versions WHERE spec_id = $1::uuid ORDER BY created_at DESC`,
    [specId]
  );
  return res.rows.map(mapSpecVersion);
}

export async function repoGetSpecVersionById(id: string, q: DbQueryer = pool): Promise<SpecVersionRow | null> {
  const res = await q.query(
    `SELECT id::text, spec_id::text, version, content_markdown, change_summary, author_id,
            approved_by, approved_at::text, created_at::text
       FROM public.project_spec_versions WHERE id = $1::uuid LIMIT 1`,
    [id]
  );
  return res.rows[0] ? mapSpecVersion(res.rows[0]) : null;
}

export async function repoCreateSpecVersion(
  tx: DbQueryer,
  input: { spec_id: string; version: string; content_markdown: string; change_summary: string | null; author_id: number }
): Promise<SpecVersionRow> {
  const res = await tx.query(
    `INSERT INTO public.project_spec_versions (spec_id, version, content_markdown, change_summary, author_id)
     VALUES ($1::uuid, $2, $3, $4, $5)
     RETURNING id::text, spec_id::text, version, content_markdown, change_summary, author_id,
               approved_by, approved_at::text, created_at::text`,
    [input.spec_id, input.version, input.content_markdown, input.change_summary, input.author_id]
  );
  const v = mapSpecVersion(res.rows[0]);
  await tx.query(
    `UPDATE public.project_specs SET current_version_id = $2::uuid, updated_at = now() WHERE id = $1::uuid`,
    [input.spec_id, v.id]
  );
  return v;
}

export async function repoApproveSpecVersion(
  tx: DbQueryer,
  versionId: string,
  approverId: number
): Promise<SpecVersionRow | null> {
  const res = await tx.query(
    `UPDATE public.project_spec_versions SET approved_by = $2, approved_at = now()
      WHERE id = $1::uuid AND approved_at IS NULL
      RETURNING id::text, spec_id::text, version, content_markdown, change_summary, author_id,
                approved_by, approved_at::text, created_at::text`,
    [versionId, approverId]
  );
  return res.rows[0] ? mapSpecVersion(res.rows[0]) : null;
}

// -------------------------------------------------------------- Décisions
function mapDecision(r: Record<string, unknown>): DecisionRow {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    title: String(r.title),
    context: (r.context as string | null) ?? null,
    options_json: r.options_json ?? null,
    decision: String(r.decision),
    consequences: (r.consequences as string | null) ?? null,
    decided_by: r.decided_by === null || r.decided_by === undefined ? null : Number(r.decided_by),
    decided_at: (r.decided_at as string | null) ?? null,
    created_at: String(r.created_at),
  };
}

export async function repoListDecisions(projectId: string, q: DbQueryer = pool): Promise<DecisionRow[]> {
  const res = await q.query(
    `SELECT id::text, project_id::text, title, context, options_json, decision, consequences,
            decided_by, decided_at::text, created_at::text
       FROM public.project_decisions WHERE project_id = $1::uuid ORDER BY created_at DESC`,
    [projectId]
  );
  return res.rows.map(mapDecision);
}

export async function repoCreateDecision(
  tx: DbQueryer,
  input: {
    project_id: string; title: string; context: string | null; options_json: unknown;
    decision: string; consequences: string | null; decided_by: number;
  }
): Promise<DecisionRow> {
  const res = await tx.query(
    `INSERT INTO public.project_decisions (project_id, title, context, options_json, decision, consequences, decided_by, decided_at)
     VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6, $7, now())
     RETURNING id::text, project_id::text, title, context, options_json, decision, consequences,
               decided_by, decided_at::text, created_at::text`,
    [
      input.project_id, input.title, input.context,
      input.options_json === null || input.options_json === undefined ? null : JSON.stringify(input.options_json),
      input.decision, input.consequences, input.decided_by,
    ]
  );
  return mapDecision(res.rows[0]);
}

// -------------------------------------------------------------- Risques
const RISK_RETURNING = `id::text, project_id::text, title, description, probability, impact, severity,
  mitigation, owner_id, status::text, created_at::text, updated_at::text`;

function mapRisk(r: Record<string, unknown>): RiskRow {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    title: String(r.title),
    description: (r.description as string | null) ?? null,
    probability: Number(r.probability),
    impact: Number(r.impact),
    severity: Number(r.severity),
    mitigation: (r.mitigation as string | null) ?? null,
    owner_id: r.owner_id === null || r.owner_id === undefined ? null : Number(r.owner_id),
    status: r.status as RiskRow["status"],
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export async function repoListRisks(projectId: string, q: DbQueryer = pool): Promise<RiskRow[]> {
  const res = await q.query(
    `SELECT ${RISK_RETURNING} FROM public.project_risks
      WHERE project_id = $1::uuid ORDER BY severity DESC, created_at`,
    [projectId]
  );
  return res.rows.map(mapRisk);
}

export async function repoGetRiskById(id: string, q: DbQueryer = pool): Promise<RiskRow | null> {
  const res = await q.query(`SELECT ${RISK_RETURNING} FROM public.project_risks WHERE id = $1::uuid LIMIT 1`, [id]);
  return res.rows[0] ? mapRisk(res.rows[0]) : null;
}

export async function repoCreateRisk(
  tx: DbQueryer,
  input: {
    project_id: string; title: string; description: string | null; probability: number;
    impact: number; mitigation: string | null; owner_id: number | null;
  }
): Promise<RiskRow> {
  const res = await tx.query(
    `INSERT INTO public.project_risks (project_id, title, description, probability, impact, mitigation, owner_id)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
     RETURNING ${RISK_RETURNING}`,
    [input.project_id, input.title, input.description, input.probability, input.impact, input.mitigation, input.owner_id]
  );
  return mapRisk(res.rows[0]);
}

export async function repoPatchRisk(tx: DbQueryer, id: string, patch: Record<string, unknown>): Promise<RiskRow | null> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [id];
  const push = (frag: string, v: unknown) => { params.push(v); sets.push(frag.replace("?", `$${params.length}`)); };
  if (patch.title !== undefined) push("title = ?", patch.title);
  if (patch.description !== undefined) push("description = ?", patch.description);
  if (patch.probability !== undefined) push("probability = ?", patch.probability);
  if (patch.impact !== undefined) push("impact = ?", patch.impact);
  if (patch.mitigation !== undefined) push("mitigation = ?", patch.mitigation);
  if (patch.owner_id !== undefined) push("owner_id = ?", patch.owner_id);
  if (patch.status !== undefined) push("status = ?::public.po_risk_status", patch.status);
  const res = await tx.query(
    `UPDATE public.project_risks SET ${sets.join(", ")} WHERE id = $1::uuid RETURNING ${RISK_RETURNING}`,
    params
  );
  return res.rows[0] ? mapRisk(res.rows[0]) : null;
}

// -------------------------------------------------------------- Actions correctives
const ACTION_RETURNING = `id::text, project_id::text, source_type::text, title, description, priority::text,
  owner_id, due_date::text, status::text, evidence_id::text, created_at::text, updated_at::text`;

function mapAction(r: Record<string, unknown>): ActionRow {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    source_type: r.source_type as ActionRow["source_type"],
    title: String(r.title),
    description: (r.description as string | null) ?? null,
    priority: r.priority as ActionRow["priority"],
    owner_id: r.owner_id === null || r.owner_id === undefined ? null : Number(r.owner_id),
    due_date: (r.due_date as string | null) ?? null,
    status: r.status as ActionRow["status"],
    evidence_id: (r.evidence_id as string | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export async function repoListActions(projectId: string, q: DbQueryer = pool): Promise<ActionRow[]> {
  const res = await q.query(
    `SELECT ${ACTION_RETURNING} FROM public.project_corrective_actions
      WHERE project_id = $1::uuid ORDER BY created_at DESC`,
    [projectId]
  );
  return res.rows.map(mapAction);
}

export async function repoGetActionById(id: string, q: DbQueryer = pool): Promise<ActionRow | null> {
  const res = await q.query(`SELECT ${ACTION_RETURNING} FROM public.project_corrective_actions WHERE id = $1::uuid LIMIT 1`, [id]);
  return res.rows[0] ? mapAction(res.rows[0]) : null;
}

export async function repoCreateAction(
  tx: DbQueryer,
  input: {
    project_id: string; source_type: string; title: string; description: string | null;
    priority: string; owner_id: number | null; due_date: string | null; evidence_id: string | null;
  }
): Promise<ActionRow> {
  const res = await tx.query(
    `INSERT INTO public.project_corrective_actions
       (project_id, source_type, title, description, priority, owner_id, due_date, evidence_id)
     VALUES ($1::uuid, $2::public.po_action_source, $3, $4, $5::public.po_priority, $6, $7::date, $8::uuid)
     RETURNING ${ACTION_RETURNING}`,
    [input.project_id, input.source_type, input.title, input.description, input.priority, input.owner_id, input.due_date, input.evidence_id]
  );
  return mapAction(res.rows[0]);
}

export async function repoPatchAction(tx: DbQueryer, id: string, patch: Record<string, unknown>): Promise<ActionRow | null> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [id];
  const push = (frag: string, v: unknown) => { params.push(v); sets.push(frag.replace("?", `$${params.length}`)); };
  if (patch.source_type !== undefined) push("source_type = ?::public.po_action_source", patch.source_type);
  if (patch.title !== undefined) push("title = ?", patch.title);
  if (patch.description !== undefined) push("description = ?", patch.description);
  if (patch.priority !== undefined) push("priority = ?::public.po_priority", patch.priority);
  if (patch.owner_id !== undefined) push("owner_id = ?", patch.owner_id);
  if (patch.due_date !== undefined) push("due_date = ?::date", patch.due_date);
  if (patch.status !== undefined) push("status = ?::public.po_action_status", patch.status);
  if (patch.evidence_id !== undefined) push("evidence_id = ?::uuid", patch.evidence_id);
  const res = await tx.query(
    `UPDATE public.project_corrective_actions SET ${sets.join(", ")} WHERE id = $1::uuid RETURNING ${ACTION_RETURNING}`,
    params
  );
  return res.rows[0] ? mapAction(res.rows[0]) : null;
}

// -------------------------------------------------------------- Preuves
const EVIDENCE_RETURNING = `id::text, project_id::text, work_package_id::text, type::text, title, url,
  description, created_by, created_at::text`;

function mapEvidence(r: Record<string, unknown>): EvidenceRow {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    work_package_id: (r.work_package_id as string | null) ?? null,
    type: r.type as EvidenceRow["type"],
    title: String(r.title),
    url: (r.url as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    created_by: Number(r.created_by),
    created_at: String(r.created_at),
  };
}

export async function repoListEvidence(
  filter: { project_id: string; work_package_id?: string; page: number; pageSize: number },
  q: DbQueryer = pool
): Promise<{ items: EvidenceRow[]; total: number }> {
  const conds = ["project_id = $1::uuid"];
  const params: unknown[] = [filter.project_id];
  if (filter.work_package_id) { params.push(filter.work_package_id); conds.push(`work_package_id = $${params.length}::uuid`); }
  const where = conds.join(" AND ");
  const totalRes = await q.query(`SELECT COUNT(*)::int AS n FROM public.project_evidence WHERE ${where}`, params);
  params.push(filter.pageSize, (filter.page - 1) * filter.pageSize);
  const res = await q.query(
    `SELECT ${EVIDENCE_RETURNING} FROM public.project_evidence WHERE ${where}
      ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: res.rows.map(mapEvidence), total: Number(totalRes.rows[0]?.n ?? 0) };
}

export async function repoGetEvidenceById(id: string, q: DbQueryer = pool): Promise<EvidenceRow | null> {
  const res = await q.query(`SELECT ${EVIDENCE_RETURNING} FROM public.project_evidence WHERE id = $1::uuid LIMIT 1`, [id]);
  return res.rows[0] ? mapEvidence(res.rows[0]) : null;
}

export async function repoCreateEvidence(
  tx: DbQueryer,
  input: {
    project_id: string; work_package_id: string | null; type: string;
    title: string; url: string | null; description: string | null; created_by: number;
  }
): Promise<EvidenceRow> {
  const res = await tx.query(
    `INSERT INTO public.project_evidence (project_id, work_package_id, type, title, url, description, created_by)
     VALUES ($1::uuid, $2::uuid, $3::public.po_evidence_type, $4, $5, $6, $7)
     RETURNING ${EVIDENCE_RETURNING}`,
    [input.project_id, input.work_package_id, input.type, input.title, input.url, input.description, input.created_by]
  );
  return mapEvidence(res.rows[0]);
}

// -------------------------------------------------------------- Liens externes
const LINK_RETURNING = `id::text, project_id::text, entity_type, entity_id::text, provider::text,
  external_type::text, external_id, url, status, created_by, created_at::text`;

function mapLink(r: Record<string, unknown>): ExternalLinkRow {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    entity_type: String(r.entity_type),
    entity_id: (r.entity_id as string | null) ?? null,
    provider: r.provider as ExternalLinkRow["provider"],
    external_type: r.external_type as ExternalLinkRow["external_type"],
    external_id: (r.external_id as string | null) ?? null,
    url: String(r.url),
    status: (r.status as string | null) ?? null,
    created_by: Number(r.created_by),
    created_at: String(r.created_at),
  };
}

export async function repoListExternalLinks(projectId: string, q: DbQueryer = pool): Promise<ExternalLinkRow[]> {
  const res = await q.query(
    `SELECT ${LINK_RETURNING} FROM public.project_external_links
      WHERE project_id = $1::uuid ORDER BY created_at DESC`,
    [projectId]
  );
  return res.rows.map(mapLink);
}

export async function repoGetExternalEntityProjectId(
  entityType: "project" | "work_package" | "spec" | "decision" | "risk" | "action",
  entityId: string,
  q: DbQueryer = pool
): Promise<string | null> {
  const tableByType = {
    project: "project_projects",
    work_package: "project_work_packages",
    spec: "project_specs",
    decision: "project_decisions",
    risk: "project_risks",
    action: "project_corrective_actions",
  } as const;
  const table = tableByType[entityType];
  const projectExpression = entityType === "project" ? "id" : "project_id";
  const res = await q.query(
    `SELECT ${projectExpression}::text AS project_id FROM public.${table} WHERE id = $1::uuid LIMIT 1`,
    [entityId]
  );
  return res.rows[0]?.project_id ? String(res.rows[0].project_id) : null;
}

export async function repoCreateExternalLink(
  tx: DbQueryer,
  input: {
    project_id: string; entity_type: string; entity_id: string | null; provider: string;
    external_type: string; external_id: string | null; url: string; status: string | null; created_by: number;
  }
): Promise<ExternalLinkRow> {
  const res = await tx.query(
    `INSERT INTO public.project_external_links
       (project_id, entity_type, entity_id, provider, external_type, external_id, url, status, created_by)
     VALUES ($1::uuid, $2, $3::uuid, $4::public.po_link_provider, $5::public.po_external_type, $6, $7, $8, $9)
     RETURNING ${LINK_RETURNING}`,
    [input.project_id, input.entity_type, input.entity_id, input.provider, input.external_type, input.external_id, input.url, input.status, input.created_by]
  );
  return mapLink(res.rows[0]);
}
