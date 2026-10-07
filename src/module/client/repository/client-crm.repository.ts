import type { PoolClient } from "pg";
import type { CrmCommand, CrmFollowupQuery } from "../validators/client-crm.validators";
import type { CrmCommandResult, CrmEvent, CrmFollowup, CrmOwner, CrmPage, CrmProfile } from "../types/client-crm.types";
import { emptyCrmProfile } from "../types/client-crm.types";

type Queryer = Pick<PoolClient, "query">;
export type CrmClientState = { client_id: string; status: string | null; blocked: boolean | null; archived_at: unknown };
function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("CRM_DATABASE_DATE_INVALID");
  return date.toISOString();
}
function profileDates(row: CrmProfile): CrmProfile {
  return { ...row, updated_at: row.updated_at ? iso(row.updated_at) : null };
}
function followupDates(row: CrmFollowup): CrmFollowup {
  return { ...row, due_at: iso(row.due_at), created_at: iso(row.created_at),
    completed_at: row.completed_at ? iso(row.completed_at) : null };
}
const FOLLOWUP_SELECT = `SELECT f.id::text,f.client_id,c.client_code,c.company_name,f.contact_id::text,
  NULLIF(concat_ws(' ',ct.first_name,ct.last_name),'') AS contact_label,
  f.owner_user_id,u.username AS owner_label,f.channel,f.purpose,f.title,f.due_at,f.status,
  f.outcome,f.result_note,f.completed_at,f.version,f.created_at,
  COALESCE(p.contact_policy,'NOT_REVIEWED') AS contact_policy,
  (c.status IS DISTINCT FROM 'inactif' AND NOT COALESCE(c.blocked,false) AND c.archived_at IS NULL) AS client_active
  FROM public.client_crm_followups f JOIN public.clients c ON c.client_id=f.client_id
  JOIN public.users u ON u.id=f.owner_user_id
  LEFT JOIN public.contacts ct ON ct.contact_id=f.contact_id
  LEFT JOIN public.client_crm_profiles p ON p.client_id=f.client_id`;

export async function readCrmClient(db: Queryer, clientId: string, lock = false) {
  const { rows } = await db.query<CrmClientState>(
    `SELECT client_id,status,blocked,archived_at FROM public.clients WHERE client_id=$1${lock ? " FOR UPDATE" : ""}`, [clientId]);
  return rows[0] ?? null;
}
export async function readCrmProfile(db: Queryer, clientId: string, lock = false): Promise<CrmProfile> {
  const { rows } = await db.query<CrmProfile>(`SELECT client_id,customer_kind,stage,owner_user_id,contact_policy,
    retention_review_date::text,version,updated_at FROM public.client_crm_profiles WHERE client_id=$1${lock ? " FOR UPDATE" : ""}`, [clientId]);
  return rows[0] ? profileDates(rows[0]) : emptyCrmProfile(clientId);
}
export async function listCrmOwners(db: Queryer): Promise<CrmOwner[]> {
  const { rows } = await db.query<CrmOwner>(`SELECT id,username AS label FROM public.users
    WHERE status='Active' ORDER BY username,id LIMIT 2000`);
  return rows;
}
export async function activeCrmOwner(db: Queryer, userId: number): Promise<boolean> {
  const result = await db.query(`SELECT id FROM public.users WHERE id=$1 AND status='Active' FOR SHARE`, [userId]);
  return result.rowCount === 1;
}
export async function activeCrmContact(db: Queryer, clientId: string, contactId: string): Promise<boolean> {
  const result = await db.query(`SELECT contact_id FROM public.contacts
    WHERE contact_id=$1::uuid AND client_id=$2 AND archived_at IS NULL FOR SHARE`, [contactId, clientId]);
  return result.rowCount === 1;
}
export async function readCrmReplay(db: Queryer, actor: number, key: string) {
  const { rows } = await db.query<{ request_hash: string; response_json: CrmCommandResult }>(
    `SELECT request_hash,response_json FROM public.client_crm_events WHERE actor_user_id=$1 AND idempotency_key=$2::uuid`, [actor, key]);
  return rows[0] ?? null;
}
export async function lockCrmIdempotency(db: Queryer, actor: number, key: string) {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`client-crm:${actor}:${key}`]);
}
export async function saveCrmProfile(db: Queryer, clientId: string, actor: number, input: Extract<CrmCommand, { action: "QUALIFY" }>) {
  await db.query(`INSERT INTO public.client_crm_profiles
    (client_id,customer_kind,stage,owner_user_id,contact_policy,retention_review_date,updated_by)
    VALUES($1,$2,$3,$4,$5,$6::date,$7)
    ON CONFLICT(client_id) DO UPDATE SET customer_kind=EXCLUDED.customer_kind,stage=EXCLUDED.stage,
    owner_user_id=EXCLUDED.owner_user_id,contact_policy=EXCLUDED.contact_policy,
    retention_review_date=EXCLUDED.retention_review_date,updated_by=EXCLUDED.updated_by,
    version=client_crm_profiles.version+1,updated_at=clock_timestamp()`,
  [clientId, input.customer_kind, input.stage, input.owner_user_id, input.contact_policy, input.retention_review_date, actor]);
  return readCrmProfile(db, clientId);
}
export async function createCrmFollowup(db: Queryer, clientId: string, actor: number, input: Extract<CrmCommand, { action: "PLAN" }>) {
  const { rows } = await db.query<{ id: string }>(`INSERT INTO public.client_crm_followups
    (client_id,contact_id,owner_user_id,channel,purpose,title,due_at,created_by)
    VALUES($1,$2::uuid,$3,$4,$5,$6,$7::timestamptz,$8) RETURNING id::text`,
  [clientId, input.contact_id, input.owner_user_id, input.channel, input.purpose, input.title, input.due_at, actor]);
  return readCrmFollowup(db, clientId, rows[0].id);
}
export async function readCrmFollowup(db: Queryer, clientId: string, id: string, lock = false): Promise<CrmFollowup | null> {
  if (lock) await db.query(`SELECT id FROM public.client_crm_followups WHERE id=$1::uuid AND client_id=$2 FOR UPDATE`, [id, clientId]);
  const { rows } = await db.query<CrmFollowup>(`${FOLLOWUP_SELECT} WHERE f.id=$1::uuid AND f.client_id=$2`, [id, clientId]);
  return rows[0] ? followupDates(rows[0]) : null;
}
export async function changeCrmFollowup(db: Queryer, clientId: string,
  input: Extract<CrmCommand, { action: "RESCHEDULE" | "COMPLETE" | "CANCEL" }>) {
  if (input.action === "RESCHEDULE") {
    await db.query(`UPDATE public.client_crm_followups SET due_at=$3::timestamptz,owner_user_id=$4,version=version+1
      WHERE id=$1::uuid AND client_id=$2`, [input.followup_id, clientId, input.due_at, input.owner_user_id]);
  } else {
    await db.query(`UPDATE public.client_crm_followups SET status=$3,outcome=$4,result_note=$5,
      completed_at=clock_timestamp(),version=version+1 WHERE id=$1::uuid AND client_id=$2`,
    [input.followup_id, clientId, input.action === "COMPLETE" ? "COMPLETED" : "CANCELLED",
      input.action === "COMPLETE" ? input.outcome : null, input.action === "COMPLETE" ? input.note : input.reason]);
  }
  return readCrmFollowup(db, clientId, input.followup_id);
}
export async function appendCrmEvent(db: Queryer, input: { id: string; clientId: string; followupId: string | null;
  action: CrmEvent["action"]; actor: number; key: string; hash: string; details: Record<string, unknown>; result: CrmCommandResult }) {
  await db.query(`INSERT INTO public.client_crm_events
    (id,client_id,followup_id,action,actor_user_id,idempotency_key,request_hash,details,response_json)
    VALUES($1::uuid,$2,$3::uuid,$4,$5,$6::uuid,$7,$8::jsonb,$9::jsonb)`,
  [input.id, input.clientId, input.followupId, input.action, input.actor, input.key, input.hash,
    JSON.stringify(input.details), JSON.stringify(input.result)]);
}
export async function listClientCrmFollowups(db: Queryer, clientId: string, page: number): Promise<CrmPage<CrmFollowup>> {
  const size = 25;
  const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM public.client_crm_followups WHERE client_id=$1`, [clientId]);
  const { rows } = await db.query<CrmFollowup>(`${FOLLOWUP_SELECT} WHERE f.client_id=$1
    ORDER BY (f.status='PLANNED') DESC,
      CASE WHEN f.status='PLANNED' THEN f.due_at END ASC,
      CASE WHEN f.status<>'PLANNED' THEN f.due_at END DESC,f.id DESC LIMIT $2 OFFSET $3`, [clientId, size, (page - 1) * size]);
  return { items: rows.map(followupDates), total: count.rows[0].total, page, page_size: size };
}
export async function listClientCrmEvents(db: Queryer, clientId: string, page: number): Promise<CrmPage<CrmEvent>> {
  const size = 25;
  const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM public.client_crm_events WHERE client_id=$1`, [clientId]);
  const { rows } = await db.query<CrmEvent>(`SELECT e.id::text,e.client_id,e.followup_id::text,e.action,e.actor_user_id,
    u.username AS actor_label,e.occurred_at,e.details FROM public.client_crm_events e
    JOIN public.users u ON u.id=e.actor_user_id WHERE e.client_id=$1 ORDER BY e.occurred_at DESC,e.id DESC LIMIT $2 OFFSET $3`,
  [clientId, size, (page - 1) * size]);
  return { items: rows.map(row => ({ ...row, occurred_at: iso(row.occurred_at) })), total: count.rows[0].total, page, page_size: size };
}
export async function listDueCrmFollowups(db: Queryer, query: CrmFollowupQuery): Promise<CrmPage<CrmFollowup>> {
  const values: unknown[] = [];
  const conditions = ["f.status='PLANNED'", "c.status IS DISTINCT FROM 'inactif'", "NOT COALESCE(c.blocked,false)", "c.archived_at IS NULL"];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  if (query.scope === "OVERDUE") conditions.push("f.due_at<=now()");
  if (query.scope === "UPCOMING") conditions.push(`f.due_at>now() AND f.due_at<=now()+${bind(query.days)}::int*interval '1 day'`);
  if (query.owner_user_id !== undefined) conditions.push(`f.owner_user_id=${bind(query.owner_user_id)}`);
  if (query.client_id) conditions.push(`f.client_id=${bind(query.client_id)}`);
  const where = conditions.join(" AND ");
  const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM public.client_crm_followups f
    JOIN public.clients c ON c.client_id=f.client_id WHERE ${where}`, values);
  const rows = await db.query<CrmFollowup>(`${FOLLOWUP_SELECT} WHERE ${where}
    ORDER BY f.due_at,f.id LIMIT ${bind(query.page_size)} OFFSET ${bind((query.page - 1) * query.page_size)}`, values);
  return { items: rows.rows.map(followupDates), total: count.rows[0].total, page: query.page, page_size: query.page_size };
}
