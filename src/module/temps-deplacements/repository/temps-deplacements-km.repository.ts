import pool from "../../../config/database";
import type { DbQueryer } from "./temps-deplacements.repository";

// T6 — kilomètres. Statuts : DRAFT → SUBMITTED → VALIDATED | REJECTED.
export type HrKmType = "MISSION" | "CLIENT" | "FOURNISSEUR" | "LIVRAISON" | "AUTRE";
export type HrKmStatus = "DRAFT" | "SUBMITTED" | "VALIDATED" | "REJECTED";

export interface KmEntry {
  id: string;
  employee_id: string;
  date: string;
  type: HrKmType;
  vehicle_id: string | null;
  start_location: string | null;
  end_location: string | null;
  start_odometer: number | null;
  end_odometer: number | null;
  distance_km: number;
  affaire_id: number | null;
  client_id: number | null;
  fournisseur_id: number | null;
  status: HrKmStatus;
  created_at: string;
  validated_by: number | null;
  validated_at: string | null;
}
export type KmEntryWithEmployee = KmEntry & { matricule: string };

export interface KmEntryInput {
  employee_id: string;
  date: string;
  type: HrKmType;
  vehicle_id: string | null;
  start_location: string | null;
  end_location: string | null;
  start_odometer: number | null;
  end_odometer: number | null;
  distance_km: number;
  affaire_id: number | null;
  client_id: number | null;
  fournisseur_id: number | null;
  status: HrKmStatus;
}

const KM_COLS = `id::text, employee_id::text, date::text, type::text, vehicle_id::text,
  start_location, end_location, start_odometer, end_odometer, distance_km,
  affaire_id, client_id, fournisseur_id, status::text, created_at::text, validated_by, validated_at::text`;

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function mapKm(r: Record<string, unknown>): KmEntry {
  return {
    id: String(r.id),
    employee_id: String(r.employee_id),
    date: String(r.date),
    type: r.type as HrKmType,
    vehicle_id: (r.vehicle_id as string | null) ?? null,
    start_location: (r.start_location as string | null) ?? null,
    end_location: (r.end_location as string | null) ?? null,
    start_odometer: num(r.start_odometer),
    end_odometer: num(r.end_odometer),
    distance_km: num(r.distance_km) ?? 0,
    affaire_id: num(r.affaire_id),
    client_id: num(r.client_id),
    fournisseur_id: num(r.fournisseur_id),
    status: r.status as HrKmStatus,
    created_at: String(r.created_at),
    validated_by: num(r.validated_by),
    validated_at: (r.validated_at as string | null) ?? null,
  };
}

export async function repoCreateKmEntry(q: DbQueryer, i: KmEntryInput): Promise<KmEntry> {
  const res = await q.query(
    `INSERT INTO public.hr_kilometer_entries
       (employee_id, date, type, vehicle_id, start_location, end_location, start_odometer, end_odometer,
        distance_km, affaire_id, client_id, fournisseur_id, status)
     VALUES ($1::uuid,$2::date,$3::hr_km_type,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::hr_km_status)
     RETURNING ${KM_COLS}`,
    [i.employee_id, i.date, i.type, i.vehicle_id, i.start_location, i.end_location, i.start_odometer, i.end_odometer,
     i.distance_km, i.affaire_id, i.client_id, i.fournisseur_id, i.status]
  );
  return mapKm(res.rows[0]);
}

export async function repoGetKmEntryById(id: string, q: DbQueryer = pool): Promise<KmEntry | null> {
  const res = await q.query(`SELECT ${KM_COLS} FROM public.hr_kilometer_entries WHERE id = $1::uuid LIMIT 1`, [id]);
  return res.rows[0] ? mapKm(res.rows[0]) : null;
}

export async function repoListKmForEmployee(
  employeeId: string,
  filters: { from?: string; to?: string; status?: HrKmStatus },
  q: DbQueryer = pool
): Promise<KmEntry[]> {
  const where: string[] = ["employee_id = $1::uuid"];
  const vals: unknown[] = [employeeId];
  if (filters.from) { vals.push(filters.from); where.push(`date >= $${vals.length}::date`); }
  if (filters.to) { vals.push(filters.to); where.push(`date <= $${vals.length}::date`); }
  if (filters.status) { vals.push(filters.status); where.push(`status = $${vals.length}::hr_km_status`); }
  const res = await q.query(`SELECT ${KM_COLS} FROM public.hr_kilometer_entries WHERE ${where.join(" AND ")} ORDER BY date DESC, created_at DESC LIMIT 500`, vals);
  return res.rows.map(mapKm);
}

// DRAFT → SUBMITTED (par le salarié). Ne modifie que si DRAFT.
export async function repoSubmitKmEntry(q: DbQueryer, id: string): Promise<KmEntry | null> {
  const res = await q.query(
    `UPDATE public.hr_kilometer_entries SET status='SUBMITTED'::hr_km_status
      WHERE id=$1::uuid AND status='DRAFT'::hr_km_status RETURNING ${KM_COLS}`,
    [id]
  );
  return res.rows[0] ? mapKm(res.rows[0]) : null;
}

// SUBMITTED → VALIDATED | REJECTED (par le responsable). Ne modifie que si SUBMITTED.
export async function repoDecideKmEntry(q: DbQueryer, id: string, status: "VALIDATED" | "REJECTED", validatedBy: number): Promise<KmEntry | null> {
  const res = await q.query(
    `UPDATE public.hr_kilometer_entries SET status=$2::hr_km_status, validated_by=$3, validated_at=now()
      WHERE id=$1::uuid AND status='SUBMITTED'::hr_km_status RETURNING ${KM_COLS}`,
    [id, status, validatedBy]
  );
  return res.rows[0] ? mapKm(res.rows[0]) : null;
}

export async function repoListTeamKmEntries(
  filters: { managerUserId: number; isPrivileged: boolean; status?: HrKmStatus },
  q: DbQueryer = pool
): Promise<KmEntryWithEmployee[]> {
  const where: string[] = ["($1::boolean OR e.manager_user_id = $2::int)"];
  const vals: unknown[] = [filters.isPrivileged, filters.managerUserId];
  if (filters.status) { vals.push(filters.status); where.push(`k.status = $${vals.length}::hr_km_status`); }
  const res = await q.query(
    `SELECT ${KM_COLS.split(", ").map((c) => "k." + c).join(", ")}, e.matricule
       FROM public.hr_kilometer_entries k
       JOIN public.hr_employees e ON e.id = k.employee_id
      WHERE ${where.join(" AND ")}
      ORDER BY k.date DESC, k.created_at DESC LIMIT 500`,
    vals
  );
  return res.rows.map((r) => ({ ...mapKm(r), matricule: String(r.matricule) }));
}

// -------------------------------------------------------------- Véhicules
export async function repoListVehicles(q: DbQueryer = pool) {
  const res = await q.query(`SELECT id::text, label, plate, owner_type::text, active FROM public.hr_vehicles WHERE active ORDER BY label ASC LIMIT 500`);
  return res.rows;
}
export async function repoCreateVehicle(q: DbQueryer, i: { label: string; plate: string | null; owner_type: "COMPANY" | "PERSONAL" }) {
  const res = await q.query(
    `INSERT INTO public.hr_vehicles (label, plate, owner_type) VALUES ($1,$2,$3::hr_vehicle_owner)
     RETURNING id::text, label, plate, owner_type::text, active`,
    [i.label, i.plate, i.owner_type]
  );
  return res.rows[0];
}
