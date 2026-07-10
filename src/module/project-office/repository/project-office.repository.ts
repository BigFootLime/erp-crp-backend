import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import type {
  ActivityRow,
  MemberRow,
  PoMemberRole,
  ProjectAccess,
  ProjectRow,
} from "../types/project-office.types";

export type DbQueryer = Pick<PoolClient, "query">;

export const PROJECT_OFFICE_FLAG_KEY = "PROJECT_OFFICE";

// Contexte d'audit (même forme que le reste de l'ERP). Jamais de secret/PII sensible dedans.
export type AuditContext = {
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

export function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505";
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}

// Audit global ERP (erp_audit_logs), écrit dans la MÊME transaction que la mutation.
export async function insertAuditLog(
  tx: DbQueryer,
  audit: AuditContext,
  entry: { action: string; entity_type: string | null; entity_id: string | null; details?: Record<string, unknown> | null }
): Promise<void> {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: entry.details ?? null,
  };
  await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}

// Audit métier du module (project_activity_log) : before/after JSON par entité.
export async function insertProjectActivity(
  tx: DbQueryer,
  input: {
    project_id: string;
    entity_type: string;
    entity_id: string | null;
    action: string;
    actor_id: number;
    before_json?: unknown;
    after_json?: unknown;
  }
): Promise<void> {
  await tx.query(
    `INSERT INTO public.project_activity_log
       (project_id, entity_type, entity_id, action, actor_id, before_json, after_json)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::jsonb, $7::jsonb)`,
    [
      input.project_id,
      input.entity_type,
      input.entity_id,
      input.action,
      input.actor_id,
      input.before_json === undefined ? null : JSON.stringify(input.before_json),
      input.after_json === undefined ? null : JSON.stringify(input.after_json),
    ]
  );
}

// -------------------------------------------------------------- Feature flag (fail-closed)
// access = override utilisateur si présent, sinon valeur globale du flag, sinon false.
export async function repoResolveFeatureAccess(
  flagKey: string,
  userId: number,
  q: DbQueryer = pool
): Promise<boolean> {
  const res = await q.query(
    `SELECT ff.enabled AS global_enabled, ffu.enabled AS user_enabled
       FROM public.app_feature_flags ff
       LEFT JOIN public.app_feature_flag_users ffu
         ON ffu.feature_flag_id = ff.id AND ffu.user_id = $2
      WHERE ff.key = $1
      LIMIT 1`,
    [flagKey, userId]
  );
  const row = res.rows[0] as { global_enabled: boolean; user_enabled: boolean | null } | undefined;
  if (!row) return false; // flag absent ⇒ fermé
  return row.user_enabled === null || row.user_enabled === undefined ? row.global_enabled === true : row.user_enabled === true;
}

// -------------------------------------------------------------- Projets
const PROJECT_COLS = `p.id::text, p.code, p.name, p.description, p.owner_id, p.visibility::text,
  p.status::text, p.start_date::text, p.target_date::text, p.created_at::text, p.updated_at::text`;

function mapProject(r: Record<string, unknown>): ProjectRow {
  return {
    id: String(r.id),
    code: String(r.code),
    name: String(r.name),
    description: (r.description as string | null) ?? null,
    owner_id: Number(r.owner_id),
    visibility: r.visibility as ProjectRow["visibility"],
    status: r.status as ProjectRow["status"],
    start_date: (r.start_date as string | null) ?? null,
    target_date: (r.target_date as string | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

// Accès effectif au projet (anti-IDOR) : null ⇒ le projet n'existe pas POUR CET UTILISATEUR (404).
export async function repoGetProjectAccess(
  projectId: string,
  userId: number,
  q: DbQueryer = pool
): Promise<ProjectAccess | null> {
  const res = await q.query(
    `SELECT p.id::text, p.visibility::text, p.owner_id, m.role::text AS member_role
       FROM public.project_projects p
       LEFT JOIN public.project_members m ON m.project_id = p.id AND m.user_id = $2
      WHERE p.id = $1::uuid
      LIMIT 1`,
    [projectId, userId]
  );
  const row = res.rows[0] as
    | { id: string; visibility: ProjectAccess["visibility"]; owner_id: number; member_role: PoMemberRole | null }
    | undefined;
  if (!row) return null;
  let effective: PoMemberRole | null = null;
  if (Number(row.owner_id) === userId) effective = "OWNER";
  else if (row.member_role) effective = row.member_role;
  else if (row.visibility === "INTERNAL") effective = "VIEWER";
  if (!effective) return null; // PRIVATE/PILOT non-membre ⇒ invisible (404 contrôlé, pas de fuite)
  return { project_id: row.id, visibility: row.visibility, owner_id: Number(row.owner_id), effective_role: effective };
}

export async function repoListProjects(
  userId: number,
  opts: { q?: string; status?: string; page: number; pageSize: number },
  q: DbQueryer = pool
): Promise<{ items: ProjectRow[]; total: number }> {
  const conds: string[] = [
    `(p.owner_id = $1 OR p.visibility = 'INTERNAL' OR EXISTS (
        SELECT 1 FROM public.project_members m WHERE m.project_id = p.id AND m.user_id = $1))`,
  ];
  const params: unknown[] = [userId];
  if (opts.q) {
    params.push(`%${opts.q}%`);
    conds.push(`(p.name ILIKE $${params.length} OR p.code ILIKE $${params.length})`);
  }
  if (opts.status) {
    params.push(opts.status);
    conds.push(`p.status = $${params.length}::public.po_project_status`);
  }
  const where = conds.join(" AND ");
  const totalRes = await q.query(`SELECT COUNT(*)::int AS n FROM public.project_projects p WHERE ${where}`, params);
  params.push(opts.pageSize, (opts.page - 1) * opts.pageSize);
  const res = await q.query(
    `SELECT ${PROJECT_COLS} FROM public.project_projects p
      WHERE ${where}
      ORDER BY p.updated_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: res.rows.map(mapProject), total: Number(totalRes.rows[0]?.n ?? 0) };
}

export async function repoGetProjectById(projectId: string, q: DbQueryer = pool): Promise<ProjectRow | null> {
  const res = await q.query(`SELECT ${PROJECT_COLS} FROM public.project_projects p WHERE p.id = $1::uuid LIMIT 1`, [projectId]);
  return res.rows[0] ? mapProject(res.rows[0]) : null;
}

export async function repoCreateProject(
  tx: DbQueryer,
  input: {
    code: string;
    name: string;
    description: string | null;
    owner_id: number;
    visibility: string;
    status: string;
    start_date: string | null;
    target_date: string | null;
  }
): Promise<ProjectRow> {
  const res = await tx.query(
    `INSERT INTO public.project_projects (code, name, description, owner_id, visibility, status, start_date, target_date)
     VALUES ($1, $2, $3, $4, $5::public.po_project_visibility, $6::public.po_project_status, $7::date, $8::date)
     RETURNING id::text, code, name, description, owner_id, visibility::text, status::text,
               start_date::text, target_date::text, created_at::text, updated_at::text`,
    [input.code, input.name, input.description, input.owner_id, input.visibility, input.status, input.start_date, input.target_date]
  );
  return mapProject(res.rows[0]);
}

export async function repoPatchProject(
  tx: DbQueryer,
  projectId: string,
  patch: Partial<{
    name: string;
    description: string | null;
    visibility: string;
    status: string;
    start_date: string | null;
    target_date: string | null;
  }>
): Promise<ProjectRow | null> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [projectId];
  const add = (frag: string, v: unknown) => {
    params.push(v);
    sets.push(`${frag} $${params.length}`);
  };
  if (patch.name !== undefined) add("name =", patch.name);
  if (patch.description !== undefined) add("description =", patch.description);
  if (patch.visibility !== undefined) { params.push(patch.visibility); sets.push(`visibility = $${params.length}::public.po_project_visibility`); }
  if (patch.status !== undefined) { params.push(patch.status); sets.push(`status = $${params.length}::public.po_project_status`); }
  if (patch.start_date !== undefined) { params.push(patch.start_date); sets.push(`start_date = $${params.length}::date`); }
  if (patch.target_date !== undefined) { params.push(patch.target_date); sets.push(`target_date = $${params.length}::date`); }
  const res = await tx.query(
    `UPDATE public.project_projects SET ${sets.join(", ")}
      WHERE id = $1::uuid
      RETURNING id::text, code, name, description, owner_id, visibility::text, status::text,
                start_date::text, target_date::text, created_at::text, updated_at::text`,
    params
  );
  return res.rows[0] ? mapProject(res.rows[0]) : null;
}

// -------------------------------------------------------------- Membres
function mapMember(r: Record<string, unknown>): MemberRow {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    user_id: Number(r.user_id),
    username: (r.username as string | null) ?? null,
    role: r.role as PoMemberRole,
    created_at: String(r.created_at),
  };
}

export async function repoListMembers(projectId: string, q: DbQueryer = pool): Promise<MemberRow[]> {
  const res = await q.query(
    `SELECT m.id::text, m.project_id::text, m.user_id, u.username, m.role::text, m.created_at::text
       FROM public.project_members m
       LEFT JOIN public.users u ON u.id = m.user_id
      WHERE m.project_id = $1::uuid
      ORDER BY m.created_at`,
    [projectId]
  );
  return res.rows.map(mapMember);
}

export async function repoUpsertMember(
  tx: DbQueryer,
  input: { project_id: string; user_id: number; role: PoMemberRole }
): Promise<MemberRow> {
  const res = await tx.query(
    `INSERT INTO public.project_members (project_id, user_id, role)
     VALUES ($1::uuid, $2, $3::public.po_member_role)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
     RETURNING id::text, project_id::text, user_id, NULL AS username, role::text, created_at::text`,
    [input.project_id, input.user_id, input.role]
  );
  return mapMember(res.rows[0]);
}

export async function repoDeleteMember(tx: DbQueryer, projectId: string, userId: number): Promise<boolean> {
  const res = await tx.query(
    `DELETE FROM public.project_members WHERE project_id = $1::uuid AND user_id = $2`,
    [projectId, userId]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function repoUserExists(userId: number, q: DbQueryer = pool): Promise<boolean> {
  const res = await q.query(`SELECT 1 FROM public.users WHERE id = $1 LIMIT 1`, [userId]);
  return res.rows.length > 0;
}

// -------------------------------------------------------------- Activité
export async function repoListActivity(
  filter: { project_id?: string; entity_type?: string; entity_id?: string; limit: number },
  q: DbQueryer = pool
): Promise<ActivityRow[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.project_id) { params.push(filter.project_id); conds.push(`a.project_id = $${params.length}::uuid`); }
  if (filter.entity_type) { params.push(filter.entity_type); conds.push(`a.entity_type = $${params.length}`); }
  if (filter.entity_id) { params.push(filter.entity_id); conds.push(`a.entity_id = $${params.length}::uuid`); }
  params.push(filter.limit);
  const res = await q.query(
    `SELECT a.id::text, a.project_id::text, a.entity_type, a.entity_id::text, a.action, a.actor_id,
            u.username AS actor_username, a.before_json, a.after_json, a.created_at::text
       FROM public.project_activity_log a
       LEFT JOIN public.users u ON u.id = a.actor_id
      ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
      ORDER BY a.created_at DESC
      LIMIT $${params.length}`,
    params
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    id: String(r.id),
    project_id: String(r.project_id),
    entity_type: String(r.entity_type),
    entity_id: (r.entity_id as string | null) ?? null,
    action: String(r.action),
    actor_id: Number(r.actor_id),
    actor_username: (r.actor_username as string | null) ?? null,
    before_json: r.before_json ?? null,
    after_json: r.after_json ?? null,
    created_at: String(r.created_at),
  }));
}
