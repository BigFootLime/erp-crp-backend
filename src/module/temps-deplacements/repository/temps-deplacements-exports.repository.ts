import pool from "../../../config/database";
import type { PayrollWeekRow } from "../services/temps-deplacements-exports";
import type { DbQueryer } from "./temps-deplacements.repository";

// T7 — lecture des agrégats hebdo d'une période + persistance des lots d'export (figés + checksum).

export async function repoListWeeksForPeriod(periodStart: string, periodEnd: string, q: DbQueryer = pool): Promise<PayrollWeekRow[]> {
  const res = await q.query(
    `SELECT e.matricule, u.name, u.surname,
            w.week_start::text, w.week_end::text,
            w.worked_minutes, w.contract_minutes, w.overtime_25_minutes, w.overtime_50_minutes, w.absence_minutes
       FROM public.hr_timesheet_weeks w
       JOIN public.hr_employees e ON e.id = w.employee_id
       LEFT JOIN public.users u ON u.id = e.user_id
      WHERE w.week_start >= $1::date AND w.week_start <= $2::date
      ORDER BY e.matricule ASC, w.week_start ASC
      LIMIT 5000`,
    [periodStart, periodEnd]
  );
  return res.rows.map((r) => ({
    matricule: String(r.matricule),
    name: (r.name as string | null) ?? null,
    surname: (r.surname as string | null) ?? null,
    week_start: String(r.week_start),
    week_end: String(r.week_end),
    worked_minutes: Number(r.worked_minutes),
    contract_minutes: Number(r.contract_minutes),
    overtime_25_minutes: Number(r.overtime_25_minutes),
    overtime_50_minutes: Number(r.overtime_50_minutes),
    absence_minutes: Number(r.absence_minutes),
  }));
}

export interface ExportBatchInsert {
  period_start: string;
  period_end: string;
  exported_by: number;
  format: "CSV" | "PDF";
  frozen_snapshot_json: Record<string, unknown>;
  checksum: string;
}

export async function repoInsertExportBatch(q: DbQueryer, i: ExportBatchInsert) {
  const res = await q.query(
    `INSERT INTO public.hr_payroll_export_batches
       (period_start, period_end, exported_by, format, frozen_snapshot_json, checksum, status)
     VALUES ($1::date,$2::date,$3,$4::hr_export_format,$5::jsonb,$6,'GENERATED'::hr_export_status)
     RETURNING id::text, period_start::text, period_end::text, exported_by, format::text, checksum, status::text, exported_at::text`,
    [i.period_start, i.period_end, i.exported_by, i.format, JSON.stringify(i.frozen_snapshot_json), i.checksum]
  );
  return res.rows[0];
}

// Métadonnées (sans le fichier base64 — on n'expose pas les octets dans la liste).
export async function repoListExportBatches(q: DbQueryer = pool) {
  const res = await q.query(
    `SELECT id::text, period_start::text, period_end::text, exported_by, format::text, checksum, status::text,
            exported_at::text, (frozen_snapshot_json->>'row_count')::int AS row_count
       FROM public.hr_payroll_export_batches
      ORDER BY exported_at DESC LIMIT 500`
  );
  return res.rows;
}

export async function repoGetExportBatch(id: string, q: DbQueryer = pool) {
  const res = await q.query(
    `SELECT id::text, period_start::text, period_end::text, exported_by, format::text, checksum, status::text,
            exported_at::text, frozen_snapshot_json
       FROM public.hr_payroll_export_batches WHERE id = $1::uuid LIMIT 1`,
    [id]
  );
  return res.rows[0] ?? null;
}
