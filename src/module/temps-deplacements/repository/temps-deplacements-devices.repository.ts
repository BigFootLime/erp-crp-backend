import pool from "../../../config/database";
import type { DbQueryer } from "./temps-deplacements.repository";

// T8 — bornes & badges. On ne stocke QUE les empreintes (token/uid hachés) ; jamais le secret en clair.
export type HrDeviceStatus = "ACTIVE" | "DISABLED";

// Colonnes exposées : JAMAIS device_token_hash / badge_uid_hash (pas de secret hors DB).
const DEVICE_COLS = `id::text, name, location, device_type, status::text, last_seen_at::text, created_at::text`;
const BADGE_COLS = `id::text, employee_id::text, badge_label, active, issued_at::text, revoked_at::text`;

export async function repoCreateDevice(
  q: DbQueryer,
  i: { name: string; location: string | null; device_type: string | null; device_token_hash: string }
) {
  const res = await q.query(
    `INSERT INTO public.hr_time_clock_devices (name, location, device_type, device_token_hash, status)
     VALUES ($1,$2,$3,$4,'ACTIVE'::hr_device_status) RETURNING ${DEVICE_COLS}`,
    [i.name, i.location, i.device_type, i.device_token_hash]
  );
  return res.rows[0];
}
export async function repoListDevices(q: DbQueryer = pool) {
  const res = await q.query(`SELECT ${DEVICE_COLS} FROM public.hr_time_clock_devices ORDER BY created_at DESC LIMIT 500`);
  return res.rows;
}
export async function repoSetDeviceStatus(q: DbQueryer, id: string, status: HrDeviceStatus) {
  const res = await q.query(
    `UPDATE public.hr_time_clock_devices SET status=$2::hr_device_status WHERE id=$1::uuid RETURNING ${DEVICE_COLS}`,
    [id, status]
  );
  return res.rows[0] ?? null;
}
// Régénère le hash de token (rotation). Le token brut est renvoyé une seule fois par le service.
export async function repoRotateDeviceToken(q: DbQueryer, id: string, tokenHash: string) {
  const res = await q.query(
    `UPDATE public.hr_time_clock_devices SET device_token_hash=$2 WHERE id=$1::uuid RETURNING ${DEVICE_COLS}`,
    [id, tokenHash]
  );
  return res.rows[0] ?? null;
}

export async function repoCreateBadge(
  q: DbQueryer,
  i: { employee_id: string; badge_uid_hash: string; badge_label: string | null }
) {
  const res = await q.query(
    `INSERT INTO public.hr_badge_credentials (employee_id, badge_uid_hash, badge_label, active)
     VALUES ($1::uuid,$2,$3,true) RETURNING ${BADGE_COLS}`,
    [i.employee_id, i.badge_uid_hash, i.badge_label]
  );
  return res.rows[0];
}
export async function repoListBadges(q: DbQueryer, employeeId?: string) {
  if (employeeId) {
    const res = await q.query(`SELECT ${BADGE_COLS} FROM public.hr_badge_credentials WHERE employee_id=$1::uuid ORDER BY issued_at DESC LIMIT 500`, [employeeId]);
    return res.rows;
  }
  const res = await q.query(`SELECT ${BADGE_COLS} FROM public.hr_badge_credentials ORDER BY issued_at DESC LIMIT 500`);
  return res.rows;
}
export async function repoRevokeBadge(q: DbQueryer, id: string) {
  const res = await q.query(
    `UPDATE public.hr_badge_credentials SET active=false, revoked_at=now() WHERE id=$1::uuid AND active=true RETURNING ${BADGE_COLS}`,
    [id]
  );
  return res.rows[0] ?? null;
}
