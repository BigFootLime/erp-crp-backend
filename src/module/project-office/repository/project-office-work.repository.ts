import pool from "../../../config/database";
import type { DbQueryer } from "./project-office.repository";
import type {
  CommentRow,
  DependencyRow,
  MilestoneRow,
  WorkPackageRow,
} from "../types/project-office.types";

const WP_COLS = `w.id::text, w.project_id::text, w.parent_id::text, w.code, w.title, w.description,
  w.type::text, w.status::text, w.priority::text, w.assignee_id, u.username AS assignee_username,
  w.reporter_id, w.start_date::text, w.due_date::text, w.progress_percent,
  w.estimated_hours::text, w.spent_hours::text, w.created_at::text, w.updated_at::text`;

function mapWp(r: Record<string, unknown>): WorkPackageRow {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    parent_id: (r.parent_id as string | null) ?? null,
    code: String(r.code),
    title: String(r.title),
    description: (r.description as string | null) ?? null,
    type: r.type as WorkPackageRow["type"],
    status: r.status as WorkPackageRow["status"],
    priority: r.priority as WorkPackageRow["priority"],
    assignee_id: r.assignee_id === null || r.assignee_id === undefined ? null : Number(r.assignee_id),
    assignee_username: (r.assignee_username as string | null) ?? null,
    reporter_id: r.reporter_id === null || r.reporter_id === undefined ? null : Number(r.reporter_id),
    start_date: (r.start_date as string | null) ?? null,
    due_date: (r.due_date as string | null) ?? null,
    progress_percent: Number(r.progress_percent),
    estimated_hours: (r.estimated_hours as string | null) ?? null,
    spent_hours: (r.spent_hours as string | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export async function repoGetWorkPackageById(id: string, q: DbQueryer = pool): Promise<WorkPackageRow | null> {
  const res = await q.query(
    `SELECT ${WP_COLS} FROM public.project_work_packages w
      LEFT JOIN public.users u ON u.id = w.assignee_id
      WHERE w.id = $1::uuid LIMIT 1`,
    [id]
  );
  return res.rows[0] ? mapWp(res.rows[0]) : null;
}

export async function repoListWorkPackages(
  opts: {
    project_id: string;
    q?: string;
    status?: string;
    type?: string;
    assignee_id?: number;
    parent_id?: string;
    page: number;
    pageSize: number;
  },
  q: DbQueryer = pool
): Promise<{ items: WorkPackageRow[]; total: number }> {
  const conds = ["w.project_id = $1::uuid"];
  const params: unknown[] = [opts.project_id];
  if (opts.q) { params.push(`%${opts.q}%`); conds.push(`(w.title ILIKE $${params.length} OR w.code ILIKE $${params.length})`); }
  if (opts.status) { params.push(opts.status); conds.push(`w.status = $${params.length}::public.po_wp_status`); }
  if (opts.type) { params.push(opts.type); conds.push(`w.type = $${params.length}::public.po_wp_type`); }
  if (opts.assignee_id) { params.push(opts.assignee_id); conds.push(`w.assignee_id = $${params.length}`); }
  if (opts.parent_id) { params.push(opts.parent_id); conds.push(`w.parent_id = $${params.length}::uuid`); }
  const where = conds.join(" AND ");
  const totalRes = await q.query(`SELECT COUNT(*)::int AS n FROM public.project_work_packages w WHERE ${where}`, params);
  params.push(opts.pageSize, (opts.page - 1) * opts.pageSize);
  const res = await q.query(
    `SELECT ${WP_COLS} FROM public.project_work_packages w
      LEFT JOIN public.users u ON u.id = w.assignee_id
      WHERE ${where}
      ORDER BY w.created_at
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: res.rows.map(mapWp), total: Number(totalRes.rows[0]?.n ?? 0) };
}

// Toutes les tâches d'un projet (Gantt/Kanban) — pas de pagination, tri hiérarchique stable.
export async function repoListAllWorkPackages(projectId: string, q: DbQueryer = pool): Promise<WorkPackageRow[]> {
  const res = await q.query(
    `SELECT ${WP_COLS} FROM public.project_work_packages w
      LEFT JOIN public.users u ON u.id = w.assignee_id
      WHERE w.project_id = $1::uuid
      ORDER BY w.code`,
    [projectId]
  );
  return res.rows.map(mapWp);
}

export async function repoNextWorkPackageCode(tx: DbQueryer, projectId: string): Promise<string> {
  // Verrouille la ligne projet pour sérialiser la numérotation (WP-001, WP-002, ...).
  await tx.query(`SELECT 1 FROM public.project_projects WHERE id = $1::uuid FOR UPDATE`, [projectId]);
  const res = await tx.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::int), 0) + 1 AS n
       FROM public.project_work_packages WHERE project_id = $1::uuid`,
    [projectId]
  );
  const n = Number(res.rows[0]?.n ?? 1);
  return `WP-${String(n).padStart(3, "0")}`;
}

export async function repoCreateWorkPackage(
  tx: DbQueryer,
  input: {
    project_id: string;
    parent_id: string | null;
    code: string;
    title: string;
    description: string | null;
    type: string;
    status: string;
    priority: string;
    assignee_id: number | null;
    reporter_id: number;
    start_date: string | null;
    due_date: string | null;
    estimated_hours: number | null;
  }
): Promise<WorkPackageRow> {
  const res = await tx.query(
    `INSERT INTO public.project_work_packages
       (project_id, parent_id, code, title, description, type, status, priority,
        assignee_id, reporter_id, start_date, due_date, estimated_hours)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::public.po_wp_type, $7::public.po_wp_status,
             $8::public.po_priority, $9, $10, $11::date, $12::date, $13)
     RETURNING id::text`,
    [
      input.project_id, input.parent_id, input.code, input.title, input.description,
      input.type, input.status, input.priority, input.assignee_id, input.reporter_id,
      input.start_date, input.due_date, input.estimated_hours,
    ]
  );
  const created = await repoGetWorkPackageById(String(res.rows[0].id), tx);
  if (!created) throw new Error("work package créé introuvable");
  return created;
}

export async function repoPatchWorkPackage(
  tx: DbQueryer,
  id: string,
  patch: Record<string, unknown>
): Promise<WorkPackageRow | null> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [id];
  const push = (frag: string, v: unknown) => { params.push(v); sets.push(frag.replace("?", `$${params.length}`)); };
  if (patch.parent_id !== undefined) push("parent_id = ?::uuid", patch.parent_id);
  if (patch.title !== undefined) push("title = ?", patch.title);
  if (patch.description !== undefined) push("description = ?", patch.description);
  if (patch.type !== undefined) push("type = ?::public.po_wp_type", patch.type);
  if (patch.status !== undefined) push("status = ?::public.po_wp_status", patch.status);
  if (patch.priority !== undefined) push("priority = ?::public.po_priority", patch.priority);
  if (patch.assignee_id !== undefined) push("assignee_id = ?", patch.assignee_id);
  if (patch.start_date !== undefined) push("start_date = ?::date", patch.start_date);
  if (patch.due_date !== undefined) push("due_date = ?::date", patch.due_date);
  if (patch.progress_percent !== undefined) push("progress_percent = ?", patch.progress_percent);
  if (patch.estimated_hours !== undefined) push("estimated_hours = ?", patch.estimated_hours);
  if (patch.spent_hours !== undefined) push("spent_hours = ?", patch.spent_hours);
  const res = await tx.query(
    `UPDATE public.project_work_packages SET ${sets.join(", ")} WHERE id = $1::uuid RETURNING id::text`,
    params
  );
  if (!res.rows[0]) return null;
  return repoGetWorkPackageById(id, tx);
}

// -------------------------------------------------------------- Dépendances
function mapDep(r: Record<string, unknown>): DependencyRow {
  return {
    id: String(r.id),
    source_work_package_id: String(r.source_work_package_id),
    target_work_package_id: String(r.target_work_package_id),
    dependency_type: r.dependency_type as DependencyRow["dependency_type"],
    created_at: String(r.created_at),
  };
}

export async function repoCreateDependency(
  tx: DbQueryer,
  input: { source_work_package_id: string; target_work_package_id: string; dependency_type: string }
): Promise<DependencyRow> {
  const res = await tx.query(
    `INSERT INTO public.project_dependencies (source_work_package_id, target_work_package_id, dependency_type)
     VALUES ($1::uuid, $2::uuid, $3::public.po_dependency_type)
     RETURNING id::text, source_work_package_id::text, target_work_package_id::text, dependency_type::text, created_at::text`,
    [input.source_work_package_id, input.target_work_package_id, input.dependency_type]
  );
  return mapDep(res.rows[0]);
}

export async function repoListProjectDependencies(projectId: string, q: DbQueryer = pool): Promise<DependencyRow[]> {
  const res = await q.query(
    `SELECT d.id::text, d.source_work_package_id::text, d.target_work_package_id::text,
            d.dependency_type::text, d.created_at::text
       FROM public.project_dependencies d
       JOIN public.project_work_packages s ON s.id = d.source_work_package_id
      WHERE s.project_id = $1::uuid
      ORDER BY d.created_at`,
    [projectId]
  );
  return res.rows.map(mapDep);
}

// Détection de cycle BLOCKS/REQUIRES : existe-t-il déjà un chemin target →…→ source ?
export async function repoDependencyPathExists(
  sourceId: string,
  targetId: string,
  q: DbQueryer = pool
): Promise<boolean> {
  const res = await q.query(
    `WITH RECURSIVE reach AS (
       SELECT d.target_work_package_id AS node
         FROM public.project_dependencies d
        WHERE d.source_work_package_id = $1::uuid AND d.dependency_type IN ('BLOCKS','REQUIRES')
       UNION
       SELECT d.target_work_package_id
         FROM public.project_dependencies d
         JOIN reach r ON r.node = d.source_work_package_id
        WHERE d.dependency_type IN ('BLOCKS','REQUIRES')
     )
     SELECT 1 FROM reach WHERE node = $2::uuid LIMIT 1`,
    [sourceId, targetId]
  );
  return res.rows.length > 0;
}

// -------------------------------------------------------------- Commentaires
function mapComment(r: Record<string, unknown>): CommentRow {
  return {
    id: String(r.id),
    work_package_id: String(r.work_package_id),
    author_id: Number(r.author_id),
    author_username: (r.author_username as string | null) ?? null,
    body_markdown: String(r.body_markdown),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export async function repoCreateComment(
  tx: DbQueryer,
  input: { work_package_id: string; author_id: number; body_markdown: string }
): Promise<CommentRow> {
  const res = await tx.query(
    `INSERT INTO public.project_comments (work_package_id, author_id, body_markdown)
     VALUES ($1::uuid, $2, $3)
     RETURNING id::text, work_package_id::text, author_id, NULL AS author_username,
               body_markdown, created_at::text, updated_at::text`,
    [input.work_package_id, input.author_id, input.body_markdown]
  );
  return mapComment(res.rows[0]);
}

export async function repoListComments(workPackageId: string, q: DbQueryer = pool): Promise<CommentRow[]> {
  const res = await q.query(
    `SELECT c.id::text, c.work_package_id::text, c.author_id, u.username AS author_username,
            c.body_markdown, c.created_at::text, c.updated_at::text
       FROM public.project_comments c
       LEFT JOIN public.users u ON u.id = c.author_id
      WHERE c.work_package_id = $1::uuid
      ORDER BY c.created_at`,
    [workPackageId]
  );
  return res.rows.map(mapComment);
}

// -------------------------------------------------------------- Jalons
function mapMilestone(r: Record<string, unknown>): MilestoneRow {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    name: String(r.name),
    description: (r.description as string | null) ?? null,
    due_date: (r.due_date as string | null) ?? null,
    status: r.status as MilestoneRow["status"],
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

const MILESTONE_RETURNING = `id::text, project_id::text, name, description, due_date::text, status::text, created_at::text, updated_at::text`;

export async function repoListMilestones(projectId: string, q: DbQueryer = pool): Promise<MilestoneRow[]> {
  const res = await q.query(
    `SELECT ${MILESTONE_RETURNING} FROM public.project_milestones
      WHERE project_id = $1::uuid ORDER BY due_date NULLS LAST, created_at`,
    [projectId]
  );
  return res.rows.map(mapMilestone);
}

export async function repoGetMilestoneById(id: string, q: DbQueryer = pool): Promise<MilestoneRow | null> {
  const res = await q.query(`SELECT ${MILESTONE_RETURNING} FROM public.project_milestones WHERE id = $1::uuid LIMIT 1`, [id]);
  return res.rows[0] ? mapMilestone(res.rows[0]) : null;
}

export async function repoCreateMilestone(
  tx: DbQueryer,
  input: { project_id: string; name: string; description: string | null; due_date: string | null }
): Promise<MilestoneRow> {
  const res = await tx.query(
    `INSERT INTO public.project_milestones (project_id, name, description, due_date)
     VALUES ($1::uuid, $2, $3, $4::date)
     RETURNING ${MILESTONE_RETURNING}`,
    [input.project_id, input.name, input.description, input.due_date]
  );
  return mapMilestone(res.rows[0]);
}

export async function repoPatchMilestone(
  tx: DbQueryer,
  id: string,
  patch: Record<string, unknown>
): Promise<MilestoneRow | null> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [id];
  const push = (frag: string, v: unknown) => { params.push(v); sets.push(frag.replace("?", `$${params.length}`)); };
  if (patch.name !== undefined) push("name = ?", patch.name);
  if (patch.description !== undefined) push("description = ?", patch.description);
  if (patch.due_date !== undefined) push("due_date = ?::date", patch.due_date);
  if (patch.status !== undefined) push("status = ?::public.po_milestone_status", patch.status);
  const res = await tx.query(
    `UPDATE public.project_milestones SET ${sets.join(", ")} WHERE id = $1::uuid RETURNING ${MILESTONE_RETURNING}`,
    params
  );
  return res.rows[0] ? mapMilestone(res.rows[0]) : null;
}
