import pool from "../../../config/database";
import type { DbQueryer } from "./project-office.repository";

export type ProjectBudgetVersion = {
  id: string;
  project_id: string;
  amount: string;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  definition: string;
  source_type: "DECLARATION" | "CONTRACT" | "DOCUMENT" | "OTHER";
  source_ref: string | null;
  observed_at: string;
  reliability: "DECLARED" | "VERIFIED" | "ESTIMATED";
  supersedes_id: string | null;
  created_by: number;
  created_at: string;
};

export type ProjectAffaireLink = {
  id: string;
  project_id: string;
  affaire_id: number;
  affaire_reference: string;
  affaire_status: string;
  source_ref: string | null;
  created_by: number;
  created_at: string;
};

export type ProjectTimeBudget = {
  work_package_count: number;
  planned_hours: string | null;
  consumed_hours: string | null;
  planned_missing_count: number;
  consumed_missing_count: number;
  freshness_at: string | null;
};

const BUDGET_COLUMNS = `id::text, project_id::text, amount::text, currency,
  effective_from::text, effective_to::text, definition, source_type, source_ref,
  observed_at::text, reliability, supersedes_id::text, created_by, created_at::text`;

function mapBudget(row: Record<string, unknown>): ProjectBudgetVersion {
  return {
    id: String(row.id), project_id: String(row.project_id), amount: String(row.amount),
    currency: String(row.currency).trim(), effective_from: String(row.effective_from),
    effective_to: row.effective_to == null ? null : String(row.effective_to),
    definition: String(row.definition), source_type: row.source_type as ProjectBudgetVersion["source_type"],
    source_ref: row.source_ref == null ? null : String(row.source_ref), observed_at: String(row.observed_at),
    reliability: row.reliability as ProjectBudgetVersion["reliability"],
    supersedes_id: row.supersedes_id == null ? null : String(row.supersedes_id),
    created_by: Number(row.created_by), created_at: String(row.created_at),
  };
}

export async function repoGetCurrentProjectBudget(
  projectId: string,
  q: DbQueryer = pool,
): Promise<ProjectBudgetVersion | null> {
  const result = await q.query(
    `SELECT ${BUDGET_COLUMNS}
       FROM public.project_budget_versions
      WHERE project_id=$1::uuid AND effective_to IS NULL
      ORDER BY effective_from DESC, created_at DESC LIMIT 1`,
    [projectId],
  );
  return result.rows[0] ? mapBudget(result.rows[0]) : null;
}

export async function repoCreateProjectBudgetVersion(
  q: DbQueryer,
  input: Omit<ProjectBudgetVersion, "id" | "project_id" | "effective_to" | "supersedes_id" | "created_at"> & {
    project_id: string;
    supersedes_id: string | null;
  },
): Promise<ProjectBudgetVersion> {
  if (input.supersedes_id) {
    await q.query(
      `UPDATE public.project_budget_versions
          SET effective_to=($2::date - INTERVAL '1 day')::date
        WHERE id=$1::uuid AND effective_to IS NULL`,
      [input.supersedes_id, input.effective_from],
    );
  }
  const result = await q.query(
    `INSERT INTO public.project_budget_versions
       (project_id, amount, currency, effective_from, definition, source_type, source_ref,
        observed_at, reliability, supersedes_id, created_by)
     VALUES ($1::uuid,$2::numeric,$3,$4::date,$5,$6,$7,$8::timestamptz,$9,$10::uuid,$11)
     RETURNING ${BUDGET_COLUMNS}`,
    [input.project_id, input.amount, input.currency, input.effective_from, input.definition,
      input.source_type, input.source_ref, input.observed_at, input.reliability,
      input.supersedes_id, input.created_by],
  );
  return mapBudget(result.rows[0]);
}

export async function repoAffaireExists(affaireId: number, q: DbQueryer = pool): Promise<boolean> {
  const result = await q.query(`SELECT 1 FROM public.affaire WHERE id=$1::bigint LIMIT 1`, [affaireId]);
  return Boolean(result.rows[0]);
}

export async function repoCreateProjectAffaireLink(
  q: DbQueryer,
  input: { project_id: string; affaire_id: number; source_ref: string | null; created_by: number },
): Promise<ProjectAffaireLink> {
  const result = await q.query(
    `WITH inserted AS (
       INSERT INTO public.project_affaire_links(project_id, affaire_id, source_ref, created_by)
       VALUES ($1::uuid,$2::bigint,$3,$4)
       RETURNING *
     )
     SELECT i.id::text, i.project_id::text, i.affaire_id, a.reference AS affaire_reference,
            a.statut AS affaire_status, i.source_ref, i.created_by, i.created_at::text
       FROM inserted i JOIN public.affaire a ON a.id=i.affaire_id`,
    [input.project_id, input.affaire_id, input.source_ref, input.created_by],
  );
  const row = result.rows[0];
  return {
    id: String(row.id), project_id: String(row.project_id), affaire_id: Number(row.affaire_id),
    affaire_reference: String(row.affaire_reference), affaire_status: String(row.affaire_status),
    source_ref: row.source_ref == null ? null : String(row.source_ref),
    created_by: Number(row.created_by), created_at: String(row.created_at),
  };
}

export async function repoDeleteProjectAffaireLink(q: DbQueryer, projectId: string, linkId: string): Promise<boolean> {
  const result = await q.query(
    `DELETE FROM public.project_affaire_links WHERE id=$1::uuid AND project_id=$2::uuid RETURNING id`,
    [linkId, projectId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function repoListProjectAffaireLinks(
  projectId: string,
  q: DbQueryer = pool,
): Promise<ProjectAffaireLink[]> {
  const result = await q.query(
    `SELECT l.id::text, l.project_id::text, l.affaire_id, a.reference AS affaire_reference,
            a.statut AS affaire_status, l.source_ref, l.created_by, l.created_at::text
       FROM public.project_affaire_links l
       JOIN public.affaire a ON a.id=l.affaire_id
      WHERE l.project_id=$1::uuid
      ORDER BY a.reference, l.created_at`,
    [projectId],
  );
  return result.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id), project_id: String(row.project_id), affaire_id: Number(row.affaire_id),
    affaire_reference: String(row.affaire_reference), affaire_status: String(row.affaire_status),
    source_ref: row.source_ref == null ? null : String(row.source_ref),
    created_by: Number(row.created_by), created_at: String(row.created_at),
  }));
}

export async function repoGetProjectTimeBudget(projectId: string, q: DbQueryer = pool): Promise<ProjectTimeBudget> {
  const result = await q.query(
    `SELECT COUNT(*) FILTER (WHERE status <> 'CANCELLED')::int AS work_package_count,
            SUM(estimated_hours) FILTER (WHERE status <> 'CANCELLED')::text AS planned_hours,
            SUM(spent_hours) FILTER (WHERE status <> 'CANCELLED')::text AS consumed_hours,
            COUNT(*) FILTER (WHERE status <> 'CANCELLED' AND estimated_hours IS NULL)::int AS planned_missing_count,
            COUNT(*) FILTER (WHERE status NOT IN ('BACKLOG','CANCELLED') AND spent_hours IS NULL)::int AS consumed_missing_count,
            MAX(updated_at)::text AS freshness_at
       FROM public.project_work_packages
      WHERE project_id=$1::uuid`,
    [projectId],
  );
  const row = result.rows[0];
  return {
    work_package_count: Number(row.work_package_count ?? 0),
    planned_hours: row.planned_hours == null ? null : String(row.planned_hours),
    consumed_hours: row.consumed_hours == null ? null : String(row.consumed_hours),
    planned_missing_count: Number(row.planned_missing_count ?? 0),
    consumed_missing_count: Number(row.consumed_missing_count ?? 0),
    freshness_at: row.freshness_at == null ? null : String(row.freshness_at),
  };
}

export async function repoListOverdueMilestones(projectId: string, q: DbQueryer = pool) {
  const result = await q.query(
    `SELECT id::text, name, due_date::text, status::text, updated_at::text,
            (CURRENT_DATE-due_date)::int AS overdue_days
       FROM public.project_milestones
      WHERE project_id=$1::uuid AND due_date<CURRENT_DATE AND status='PLANNED'
      ORDER BY due_date, name`,
    [projectId],
  );
  return result.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id), name: String(row.name), due_date: String(row.due_date),
    status: String(row.status), overdue_days: Number(row.overdue_days), updated_at: String(row.updated_at),
  }));
}

export async function repoListBlockingDependencies(projectId: string, q: DbQueryer = pool) {
  const result = await q.query(
    `SELECT d.id::text, d.dependency_type::text,
            source.id::text AS source_id, source.code AS source_code, source.title AS source_title,
            source.assignee_id AS owner_id, source.due_date::text AS due_date,
            target.id::text AS target_id, target.code AS target_code, target.title AS target_title,
            target.status::text AS target_status
       FROM public.project_dependencies d
       JOIN public.project_work_packages source ON source.id=d.source_work_package_id
       JOIN public.project_work_packages target ON target.id=d.target_work_package_id
      WHERE source.project_id=$1::uuid
        AND target.project_id=$1::uuid
        AND d.dependency_type IN ('BLOCKS','REQUIRES')
        AND source.status NOT IN ('DONE','CANCELLED')
        AND target.status NOT IN ('DONE','CANCELLED')
      ORDER BY source.due_date NULLS LAST, source.priority DESC, source.code`,
    [projectId],
  );
  return result.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id), dependency_type: String(row.dependency_type),
    source: { id: String(row.source_id), code: String(row.source_code), title: String(row.source_title) },
    blocking: { id: String(row.target_id), code: String(row.target_code), title: String(row.target_title), status: String(row.target_status) },
    owner_id: row.owner_id == null ? null : Number(row.owner_id),
    due_date: row.due_date == null ? null : String(row.due_date),
    cause: `${String(row.dependency_type)}:${String(row.target_code)}:${String(row.target_status)}`,
  }));
}

export async function repoGetProjectBurnUp(projectId: string, q: DbQueryer = pool) {
  const result = await q.query(
    `WITH weeks AS (
       SELECT generate_series(
         date_trunc('week', CURRENT_DATE)::date - INTERVAL '11 weeks',
         date_trunc('week', CURRENT_DATE)::date,
         INTERVAL '1 week'
       )::date AS week_start
     )
     SELECT w.week_start::text,
            (w.week_start + 6)::date::text AS week_end,
            COUNT(p.id) FILTER (WHERE p.due_date IS NOT NULL AND p.due_date <= w.week_start + 6)::int AS planned_cumulative,
            COUNT(p.id) FILTER (WHERE p.status='DONE' AND p.updated_at::date <= w.week_start + 6)::int AS completed_cumulative
       FROM weeks w
       LEFT JOIN public.project_work_packages p ON p.project_id=$1::uuid AND p.status<>'CANCELLED'
      GROUP BY w.week_start ORDER BY w.week_start`,
    [projectId],
  );
  return result.rows.map((row: Record<string, unknown>) => ({
    week_start: String(row.week_start), week_end: String(row.week_end),
    planned_cumulative: Number(row.planned_cumulative), completed_cumulative: Number(row.completed_cumulative),
  }));
}

export async function repoGetProjectRiskMatrix(projectId: string, q: DbQueryer = pool) {
  const result = await q.query(
    `SELECT probability, impact, COUNT(*)::int AS count,
            jsonb_agg(jsonb_build_object('id',id::text,'title',title,'severity',severity,'owner_id',owner_id,'updated_at',updated_at)
                      ORDER BY severity DESC, title) AS risks
       FROM public.project_risks
      WHERE project_id=$1::uuid AND status IN ('OPEN','MITIGATED','ACCEPTED')
      GROUP BY probability, impact ORDER BY probability DESC, impact DESC`,
    [projectId],
  );
  return result.rows.map((row: Record<string, unknown>) => ({
    probability: Number(row.probability), impact: Number(row.impact), count: Number(row.count), risks: row.risks,
  }));
}
