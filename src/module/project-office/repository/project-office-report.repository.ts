import pool from "../../../config/database";
import type { DbQueryer } from "./project-office.repository";
import type {
  ErrorRecordRow,
  ReportAssetRow,
  ReportEntryRow,
  ReportRow,
  ReportSectionRow,
  ReportTemplateRow,
  WorkLogRow,
} from "../types/project-office.types";

// -------------------------------------------------------------- Templates & sections
export async function repoGetTemplateByCode(code: string, q: DbQueryer = pool): Promise<ReportTemplateRow | null> {
  const res = await q.query(
    `SELECT id::text, code, title, description, level::text, active
       FROM public.project_report_templates WHERE code = $1 AND active = true LIMIT 1`,
    [code]
  );
  const r = res.rows[0];
  if (!r) return null;
  return { id: String(r.id), code: String(r.code), title: String(r.title), description: (r.description as string | null) ?? null, level: r.level, active: r.active === true };
}

export async function repoListTemplates(q: DbQueryer = pool): Promise<ReportTemplateRow[]> {
  const res = await q.query(
    `SELECT id::text, code, title, description, level::text, active
       FROM public.project_report_templates WHERE active = true ORDER BY code`
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    id: String(r.id), code: String(r.code), title: String(r.title),
    description: (r.description as string | null) ?? null,
    level: r.level as ReportTemplateRow["level"], active: r.active === true,
  }));
}

const SECTION_COLS = `id::text, template_id::text, parent_id::text, section_number, title, description,
  expected_content, display_order`;

function mapSection(r: Record<string, unknown>): ReportSectionRow {
  return {
    id: String(r.id),
    template_id: String(r.template_id),
    parent_id: (r.parent_id as string | null) ?? null,
    section_number: String(r.section_number),
    title: String(r.title),
    description: (r.description as string | null) ?? null,
    expected_content: (r.expected_content as string | null) ?? null,
    display_order: Number(r.display_order),
  };
}

export async function repoListSections(templateId: string, q: DbQueryer = pool): Promise<ReportSectionRow[]> {
  const res = await q.query(
    `SELECT ${SECTION_COLS} FROM public.project_report_sections
      WHERE template_id = $1::uuid ORDER BY display_order`,
    [templateId]
  );
  return res.rows.map(mapSection);
}

export async function repoGetSectionById(id: string, q: DbQueryer = pool): Promise<ReportSectionRow | null> {
  const res = await q.query(`SELECT ${SECTION_COLS} FROM public.project_report_sections WHERE id = $1::uuid LIMIT 1`, [id]);
  return res.rows[0] ? mapSection(res.rows[0]) : null;
}

// -------------------------------------------------------------- Rapports
const REPORT_COLS = `id::text, project_id::text, template_id::text, title, author_id, academic_year,
  status::text, current_version_id::text, created_at::text, updated_at::text`;

function mapReport(r: Record<string, unknown>): ReportRow {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    template_id: String(r.template_id),
    title: String(r.title),
    author_id: Number(r.author_id),
    academic_year: (r.academic_year as string | null) ?? null,
    status: r.status as ReportRow["status"],
    current_version_id: (r.current_version_id as string | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export async function repoListReports(projectId: string, q: DbQueryer = pool): Promise<ReportRow[]> {
  const res = await q.query(
    `SELECT ${REPORT_COLS} FROM public.project_reports WHERE project_id = $1::uuid ORDER BY created_at DESC`,
    [projectId]
  );
  return res.rows.map(mapReport);
}

export async function repoGetReportById(id: string, q: DbQueryer = pool): Promise<ReportRow | null> {
  const res = await q.query(`SELECT ${REPORT_COLS} FROM public.project_reports WHERE id = $1::uuid LIMIT 1`, [id]);
  return res.rows[0] ? mapReport(res.rows[0]) : null;
}

export async function repoCreateReport(
  tx: DbQueryer,
  input: { project_id: string; template_id: string; title: string; author_id: number; academic_year: string | null }
): Promise<ReportRow> {
  const res = await tx.query(
    `INSERT INTO public.project_reports (project_id, template_id, title, author_id, academic_year)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5)
     RETURNING ${REPORT_COLS}`,
    [input.project_id, input.template_id, input.title, input.author_id, input.academic_year]
  );
  return mapReport(res.rows[0]);
}

export async function repoSetReportStatus(tx: DbQueryer, id: string, status: string): Promise<void> {
  await tx.query(
    `UPDATE public.project_reports SET status = $2::public.po_report_status, updated_at = now() WHERE id = $1::uuid`,
    [id, status]
  );
}

// Crée les entrées VIDE pour toutes les sections du template (à la création du rapport).
export async function repoInitReportEntries(tx: DbQueryer, reportId: string, templateId: string): Promise<number> {
  const res = await tx.query(
    `INSERT INTO public.project_report_entries (report_id, section_id)
     SELECT $1::uuid, s.id FROM public.project_report_sections s WHERE s.template_id = $2::uuid
     ON CONFLICT (report_id, section_id) DO NOTHING`,
    [reportId, templateId]
  );
  return res.rowCount ?? 0;
}

const ENTRY_COLS = `id::text, report_id::text, section_id::text, status::text, progress_percent,
  ai_draft_markdown, validated_markdown, manual_notes, last_generated_at::text,
  validated_by, validated_at::text, updated_at::text`;

function mapEntry(r: Record<string, unknown>): ReportEntryRow {
  return {
    id: String(r.id),
    report_id: String(r.report_id),
    section_id: String(r.section_id),
    status: r.status as ReportEntryRow["status"],
    progress_percent: Number(r.progress_percent),
    ai_draft_markdown: (r.ai_draft_markdown as string | null) ?? null,
    validated_markdown: (r.validated_markdown as string | null) ?? null,
    manual_notes: (r.manual_notes as string | null) ?? null,
    last_generated_at: (r.last_generated_at as string | null) ?? null,
    validated_by: r.validated_by === null || r.validated_by === undefined ? null : Number(r.validated_by),
    validated_at: (r.validated_at as string | null) ?? null,
    updated_at: String(r.updated_at),
  };
}

export async function repoListEntries(reportId: string, q: DbQueryer = pool): Promise<ReportEntryRow[]> {
  const res = await q.query(`SELECT ${ENTRY_COLS} FROM public.project_report_entries WHERE report_id = $1::uuid`, [reportId]);
  return res.rows.map(mapEntry);
}

export async function repoGetEntry(reportId: string, sectionId: string, q: DbQueryer = pool): Promise<ReportEntryRow | null> {
  const res = await q.query(
    `SELECT ${ENTRY_COLS} FROM public.project_report_entries
      WHERE report_id = $1::uuid AND section_id = $2::uuid LIMIT 1`,
    [reportId, sectionId]
  );
  return res.rows[0] ? mapEntry(res.rows[0]) : null;
}

export async function repoPatchEntry(
  tx: DbQueryer,
  reportId: string,
  sectionId: string,
  patch: Record<string, unknown>
): Promise<ReportEntryRow | null> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [reportId, sectionId];
  const push = (frag: string, v: unknown) => { params.push(v); sets.push(frag.replace("?", `$${params.length}`)); };
  if (patch.status !== undefined) push("status = ?::public.po_entry_status", patch.status);
  if (patch.progress_percent !== undefined) push("progress_percent = ?", patch.progress_percent);
  if (patch.ai_draft_markdown !== undefined) push("ai_draft_markdown = ?", patch.ai_draft_markdown);
  if (patch.validated_markdown !== undefined) push("validated_markdown = ?", patch.validated_markdown);
  if (patch.manual_notes !== undefined) push("manual_notes = ?", patch.manual_notes);
  if (patch.last_generated_at !== undefined) push("last_generated_at = ?::timestamptz", patch.last_generated_at);
  if (patch.validated_by !== undefined) push("validated_by = ?", patch.validated_by);
  if (patch.validated_at !== undefined) push("validated_at = ?::timestamptz", patch.validated_at);
  const res = await tx.query(
    `UPDATE public.project_report_entries SET ${sets.join(", ")}
      WHERE report_id = $1::uuid AND section_id = $2::uuid
      RETURNING ${ENTRY_COLS}`,
    params
  );
  return res.rows[0] ? mapEntry(res.rows[0]) : null;
}

// -------------------------------------------------------------- Preuves liées aux entrées
export async function repoLinkEntryEvidence(
  tx: DbQueryer,
  input: { report_entry_id: string; evidence_id: string; relation_type: string }
): Promise<void> {
  await tx.query(
    `INSERT INTO public.project_report_entry_evidence (report_entry_id, evidence_id, relation_type)
     VALUES ($1::uuid, $2::uuid, $3::public.po_entry_evidence_relation)
     ON CONFLICT (report_entry_id, evidence_id, relation_type) DO NOTHING`,
    [input.report_entry_id, input.evidence_id, input.relation_type]
  );
}

export type EntryEvidenceJoined = {
  evidence_id: string;
  relation_type: string;
  type: string;
  title: string;
  url: string | null;
  description: string | null;
  created_at: string;
};

export async function repoListEntryEvidence(entryId: string, q: DbQueryer = pool): Promise<EntryEvidenceJoined[]> {
  const res = await q.query(
    `SELECT ee.evidence_id::text, ee.relation_type::text, e.type::text, e.title, e.url, e.description, e.created_at::text
       FROM public.project_report_entry_evidence ee
       JOIN public.project_evidence e ON e.id = ee.evidence_id
      WHERE ee.report_entry_id = $1::uuid
      ORDER BY e.created_at`,
    [entryId]
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    evidence_id: String(r.evidence_id),
    relation_type: String(r.relation_type),
    type: String(r.type),
    title: String(r.title),
    url: (r.url as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    created_at: String(r.created_at),
  }));
}

export async function repoCountEntryEvidenceForReport(reportId: string, q: DbQueryer = pool): Promise<Map<string, number>> {
  const res = await q.query(
    `SELECT ee.report_entry_id::text AS entry_id, COUNT(*)::int AS n
       FROM public.project_report_entry_evidence ee
       JOIN public.project_report_entries en ON en.id = ee.report_entry_id
      WHERE en.report_id = $1::uuid
      GROUP BY ee.report_entry_id`,
    [reportId]
  );
  const m = new Map<string, number>();
  for (const r of res.rows) m.set(String(r.entry_id), Number(r.n));
  return m;
}

// -------------------------------------------------------------- Assets (captures) — contenu en DB (base64)
const ASSET_COLS = `id::text, project_id::text, report_entry_id::text, title, description, asset_type::text,
  mime_type, width, height, checksum, created_by, created_at::text`;

function mapAsset(r: Record<string, unknown>): ReportAssetRow {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    report_entry_id: (r.report_entry_id as string | null) ?? null,
    title: String(r.title),
    description: (r.description as string | null) ?? null,
    asset_type: r.asset_type as ReportAssetRow["asset_type"],
    mime_type: (r.mime_type as string | null) ?? null,
    width: r.width === null || r.width === undefined ? null : Number(r.width),
    height: r.height === null || r.height === undefined ? null : Number(r.height),
    checksum: (r.checksum as string | null) ?? null,
    created_by: Number(r.created_by),
    created_at: String(r.created_at),
  };
}

export async function repoListAssets(
  filter: { project_id: string; report_entry_id?: string },
  q: DbQueryer = pool
): Promise<ReportAssetRow[]> {
  const conds = ["project_id = $1::uuid"];
  const params: unknown[] = [filter.project_id];
  if (filter.report_entry_id) { params.push(filter.report_entry_id); conds.push(`report_entry_id = $${params.length}::uuid`); }
  const res = await q.query(
    `SELECT ${ASSET_COLS} FROM public.project_report_assets
      WHERE ${conds.join(" AND ")} ORDER BY created_at DESC`,
    params
  );
  return res.rows.map(mapAsset);
}

export async function repoGetAssetById(id: string, q: DbQueryer = pool): Promise<(ReportAssetRow & { content_base64: string | null }) | null> {
  const res = await q.query(
    `SELECT ${ASSET_COLS}, content_base64 FROM public.project_report_assets WHERE id = $1::uuid LIMIT 1`,
    [id]
  );
  if (!res.rows[0]) return null;
  return { ...mapAsset(res.rows[0]), content_base64: (res.rows[0].content_base64 as string | null) ?? null };
}

export async function repoCreateAsset(
  tx: DbQueryer,
  input: {
    project_id: string; report_entry_id: string | null; title: string; description: string | null;
    asset_type: string; mime_type: string | null; width: number | null; height: number | null;
    content_base64: string | null; checksum: string | null; created_by: number;
  }
): Promise<ReportAssetRow> {
  const res = await tx.query(
    `INSERT INTO public.project_report_assets
       (project_id, report_entry_id, title, description, asset_type, mime_type, width, height, content_base64, checksum, created_by)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::public.po_asset_type, $6, $7, $8, $9, $10, $11)
     RETURNING ${ASSET_COLS}`,
    [
      input.project_id, input.report_entry_id, input.title, input.description, input.asset_type,
      input.mime_type, input.width, input.height, input.content_base64, input.checksum, input.created_by,
    ]
  );
  return mapAsset(res.rows[0]);
}

// -------------------------------------------------------------- Versions & exports
export async function repoCreateReportVersion(
  tx: DbQueryer,
  input: { report_id: string; version: string; title: string; snapshot_json: unknown; generated_markdown: string | null; created_by: number }
): Promise<{ id: string; version: string; created_at: string }> {
  const res = await tx.query(
    `INSERT INTO public.project_report_versions (report_id, version, title, snapshot_json, generated_markdown, created_by)
     VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6)
     RETURNING id::text, version, created_at::text`,
    [input.report_id, input.version, input.title, JSON.stringify(input.snapshot_json ?? {}), input.generated_markdown, input.created_by]
  );
  const row = res.rows[0];
  await tx.query(
    `UPDATE public.project_reports SET current_version_id = $2::uuid, updated_at = now() WHERE id = $1::uuid`,
    [input.report_id, row.id]
  );
  return { id: String(row.id), version: String(row.version), created_at: String(row.created_at) };
}

export async function repoListReportVersions(reportId: string, q: DbQueryer = pool) {
  const res = await q.query(
    `SELECT v.id::text, v.version, v.title, v.created_by, u.username AS created_by_username, v.created_at::text
       FROM public.project_report_versions v
       LEFT JOIN public.users u ON u.id = v.created_by
      WHERE v.report_id = $1::uuid ORDER BY v.created_at DESC`,
    [reportId]
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    id: String(r.id), version: String(r.version), title: String(r.title),
    created_by: Number(r.created_by), created_by_username: (r.created_by_username as string | null) ?? null,
    created_at: String(r.created_at),
  }));
}

export async function repoCreateReportExport(
  tx: DbQueryer,
  input: {
    report_id: string; version_id: string | null; export_type: string; section_id: string | null;
    file_path: string; checksum: string; file_base64: string; exported_by: number;
  }
): Promise<{ id: string; exported_at: string }> {
  const res = await tx.query(
    `INSERT INTO public.project_report_exports
       (report_id, version_id, export_type, section_id, file_path, checksum, file_base64, exported_by)
     VALUES ($1::uuid, $2::uuid, $3::public.po_export_type, $4::uuid, $5, $6, $7, $8)
     RETURNING id::text, exported_at::text`,
    [input.report_id, input.version_id, input.export_type, input.section_id, input.file_path, input.checksum, input.file_base64, input.exported_by]
  );
  return { id: String(res.rows[0].id), exported_at: String(res.rows[0].exported_at) };
}

export async function repoListReportExports(reportId: string, q: DbQueryer = pool) {
  const res = await q.query(
    `SELECT e.id::text, e.export_type::text, e.section_id::text, e.file_path, e.checksum,
            e.exported_by, u.username AS exported_by_username, e.exported_at::text
       FROM public.project_report_exports e
       LEFT JOIN public.users u ON u.id = e.exported_by
      WHERE e.report_id = $1::uuid ORDER BY e.exported_at DESC`,
    [reportId]
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    id: String(r.id), export_type: String(r.export_type), section_id: (r.section_id as string | null) ?? null,
    file_path: String(r.file_path), checksum: String(r.checksum),
    exported_by: Number(r.exported_by), exported_by_username: (r.exported_by_username as string | null) ?? null,
    exported_at: String(r.exported_at),
  }));
}

export async function repoGetReportExportById(id: string, q: DbQueryer = pool) {
  const res = await q.query(
    `SELECT id::text, report_id::text, export_type::text, file_path, checksum, file_base64, exported_at::text
       FROM public.project_report_exports WHERE id = $1::uuid LIMIT 1`,
    [id]
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: String(r.id), report_id: String(r.report_id), export_type: String(r.export_type),
    file_path: String(r.file_path), checksum: String(r.checksum),
    file_base64: (r.file_base64 as string | null) ?? null, exported_at: String(r.exported_at),
  };
}

export async function repoInsertGenerationRun(
  tx: DbQueryer,
  input: { report_id: string; section_id: string | null; triggered_by: number; mode: string; input_context_json: unknown; output_summary: string | null }
): Promise<void> {
  await tx.query(
    `INSERT INTO public.project_report_generation_runs (report_id, section_id, triggered_by, mode, input_context_json, output_summary)
     VALUES ($1::uuid, $2::uuid, $3, $4::public.po_generation_mode, $5::jsonb, $6)`,
    [input.report_id, input.section_id, input.triggered_by, input.mode, JSON.stringify(input.input_context_json ?? {}), input.output_summary]
  );
}

// -------------------------------------------------------------- Work logs & erreurs
const WORK_LOG_COLS = `id::text, project_id::text, work_package_id::text, branch_name, pr_url, commit_sha,
  module, action_type::text, title, description, before_state, after_state, created_by, created_at::text`;

function mapWorkLog(r: Record<string, unknown>): WorkLogRow {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    work_package_id: (r.work_package_id as string | null) ?? null,
    branch_name: (r.branch_name as string | null) ?? null,
    pr_url: (r.pr_url as string | null) ?? null,
    commit_sha: (r.commit_sha as string | null) ?? null,
    module: (r.module as string | null) ?? null,
    action_type: r.action_type as WorkLogRow["action_type"],
    title: String(r.title),
    description: (r.description as string | null) ?? null,
    before_state: (r.before_state as string | null) ?? null,
    after_state: (r.after_state as string | null) ?? null,
    created_by: Number(r.created_by),
    created_at: String(r.created_at),
  };
}

export async function repoCreateWorkLog(
  tx: DbQueryer,
  input: Omit<WorkLogRow, "id" | "created_at">
): Promise<WorkLogRow> {
  const res = await tx.query(
    `INSERT INTO public.project_work_logs
       (project_id, work_package_id, branch_name, pr_url, commit_sha, module, action_type, title, description, before_state, after_state, created_by)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::public.po_work_log_action, $8, $9, $10, $11, $12)
     RETURNING ${WORK_LOG_COLS}`,
    [
      input.project_id, input.work_package_id, input.branch_name, input.pr_url, input.commit_sha,
      input.module, input.action_type, input.title, input.description, input.before_state, input.after_state, input.created_by,
    ]
  );
  return mapWorkLog(res.rows[0]);
}

export async function repoListWorkLogs(
  filter: { project_id: string; action_type?: string; page: number; pageSize: number },
  q: DbQueryer = pool
): Promise<{ items: WorkLogRow[]; total: number }> {
  const conds = ["project_id = $1::uuid"];
  const params: unknown[] = [filter.project_id];
  if (filter.action_type) { params.push(filter.action_type); conds.push(`action_type = $${params.length}::public.po_work_log_action`); }
  const where = conds.join(" AND ");
  const totalRes = await q.query(`SELECT COUNT(*)::int AS n FROM public.project_work_logs WHERE ${where}`, params);
  params.push(filter.pageSize, (filter.page - 1) * filter.pageSize);
  const res = await q.query(
    `SELECT ${WORK_LOG_COLS} FROM public.project_work_logs WHERE ${where}
      ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: res.rows.map(mapWorkLog), total: Number(totalRes.rows[0]?.n ?? 0) };
}

const ERROR_COLS = `id::text, project_id::text, work_package_id::text, title, error_message, context,
  screenshot_asset_id::text, severity::text, status::text, fix_summary, fixed_by, fixed_at::text,
  created_by, created_at::text`;

function mapError(r: Record<string, unknown>): ErrorRecordRow {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    work_package_id: (r.work_package_id as string | null) ?? null,
    title: String(r.title),
    error_message: (r.error_message as string | null) ?? null,
    context: (r.context as string | null) ?? null,
    screenshot_asset_id: (r.screenshot_asset_id as string | null) ?? null,
    severity: r.severity as ErrorRecordRow["severity"],
    status: r.status as ErrorRecordRow["status"],
    fix_summary: (r.fix_summary as string | null) ?? null,
    fixed_by: r.fixed_by === null || r.fixed_by === undefined ? null : Number(r.fixed_by),
    fixed_at: (r.fixed_at as string | null) ?? null,
    created_by: Number(r.created_by),
    created_at: String(r.created_at),
  };
}

export async function repoCreateErrorRecord(
  tx: DbQueryer,
  input: {
    project_id: string; work_package_id: string | null; title: string; error_message: string | null;
    context: string | null; screenshot_asset_id: string | null; severity: string; created_by: number;
  }
): Promise<ErrorRecordRow> {
  const res = await tx.query(
    `INSERT INTO public.project_error_records
       (project_id, work_package_id, title, error_message, context, screenshot_asset_id, severity, created_by)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::public.po_error_severity, $8)
     RETURNING ${ERROR_COLS}`,
    [input.project_id, input.work_package_id, input.title, input.error_message, input.context, input.screenshot_asset_id, input.severity, input.created_by]
  );
  return mapError(res.rows[0]);
}

export async function repoGetErrorById(id: string, q: DbQueryer = pool): Promise<ErrorRecordRow | null> {
  const res = await q.query(`SELECT ${ERROR_COLS} FROM public.project_error_records WHERE id = $1::uuid LIMIT 1`, [id]);
  return res.rows[0] ? mapError(res.rows[0]) : null;
}

export async function repoListErrorRecords(projectId: string, q: DbQueryer = pool): Promise<ErrorRecordRow[]> {
  const res = await q.query(
    `SELECT ${ERROR_COLS} FROM public.project_error_records WHERE project_id = $1::uuid ORDER BY created_at DESC`,
    [projectId]
  );
  return res.rows.map(mapError);
}

export async function repoPatchErrorRecord(
  tx: DbQueryer,
  id: string,
  patch: Record<string, unknown>
): Promise<ErrorRecordRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (frag: string, v: unknown) => { params.push(v); sets.push(frag.replace("?", `$${params.length}`)); };
  if (patch.title !== undefined) push("title = ?", patch.title);
  if (patch.error_message !== undefined) push("error_message = ?", patch.error_message);
  if (patch.context !== undefined) push("context = ?", patch.context);
  if (patch.screenshot_asset_id !== undefined) push("screenshot_asset_id = ?::uuid", patch.screenshot_asset_id);
  if (patch.severity !== undefined) push("severity = ?::public.po_error_severity", patch.severity);
  if (patch.status !== undefined) push("status = ?::public.po_error_status", patch.status);
  if (patch.fix_summary !== undefined) push("fix_summary = ?", patch.fix_summary);
  if (patch.fixed_by !== undefined) push("fixed_by = ?", patch.fixed_by);
  if (patch.fixed_at !== undefined) push("fixed_at = ?::timestamptz", patch.fixed_at);
  if (!sets.length) return repoGetErrorById(id, tx);
  const res = await tx.query(
    `UPDATE public.project_error_records SET ${sets.join(", ")} WHERE id = $1::uuid RETURNING ${ERROR_COLS}`,
    params
  );
  return res.rows[0] ? mapError(res.rows[0]) : null;
}

// -------------------------------------------------------------- Agrégats dashboard/status report
export type ProjectStats = {
  wp_total: number;
  wp_open: number;
  wp_late: number;
  wp_blocked: number;
  wp_done: number;
  by_status: Record<string, number>;
  risks_open: number;
  actions_open: number;
  milestones_next: { id: string; name: string; due_date: string | null; status: string }[];
};

export async function repoGetProjectStats(projectId: string, q: DbQueryer = pool): Promise<ProjectStats> {
  const wp = await q.query(
    `SELECT status::text, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE due_date IS NOT NULL AND due_date < CURRENT_DATE
                             AND status NOT IN ('DONE','CANCELLED'))::int AS late
       FROM public.project_work_packages WHERE project_id = $1::uuid GROUP BY status`,
    [projectId]
  );
  const byStatus: Record<string, number> = {};
  let late = 0;
  for (const r of wp.rows) { byStatus[String(r.status)] = Number(r.n); late += Number(r.late); }
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const done = byStatus.DONE ?? 0;
  const cancelled = byStatus.CANCELLED ?? 0;
  const risks = await q.query(
    `SELECT COUNT(*)::int AS n FROM public.project_risks WHERE project_id = $1::uuid AND status = 'OPEN'`,
    [projectId]
  );
  const actions = await q.query(
    `SELECT COUNT(*)::int AS n FROM public.project_corrective_actions
      WHERE project_id = $1::uuid AND status IN ('OPEN','IN_PROGRESS')`,
    [projectId]
  );
  const milestones = await q.query(
    `SELECT id::text, name, due_date::text, status::text FROM public.project_milestones
      WHERE project_id = $1::uuid AND status = 'PLANNED'
      ORDER BY due_date NULLS LAST LIMIT 5`,
    [projectId]
  );
  return {
    wp_total: total,
    wp_open: total - done - cancelled,
    wp_late: late,
    wp_blocked: byStatus.BLOCKED ?? 0,
    wp_done: done,
    by_status: byStatus,
    risks_open: Number(risks.rows[0]?.n ?? 0),
    actions_open: Number(actions.rows[0]?.n ?? 0),
    milestones_next: milestones.rows.map((r: Record<string, unknown>) => ({
      id: String(r.id), name: String(r.name), due_date: (r.due_date as string | null) ?? null, status: String(r.status),
    })),
  };
}
