import pool from "../../../config/database";
import type { OutstandingQueryDTO, RevenueQueryDTO, TopClientsQueryDTO } from "../validators/reporting.validators";

export type RevenueBucket = {
  period: string;
  total_ttc: number;
  total_ht: number;
  count_factures: number;
  count_avoirs: number;
};

export type OutstandingRow = {
  id: number;
  numero: string;
  client_id: string;
  company_name: string | null;
  date_emission: string;
  date_echeance: string | null;
  total_ttc: number;
  total_paye_ttc: number;
  total_avoirs_ttc: number;
  reste_a_payer_ttc: number;
};

export type OutstandingSummary = {
  as_of: string;
  outstanding_ttc: number;
  overdue_ttc: number;
  count_outstanding: number;
  count_overdue: number;
  overdue_invoices: OutstandingRow[];
};

export type TopClientRow = {
  client_id: string;
  company_name: string | null;
  total_ttc: number;
  count_factures: number;
  count_avoirs: number;
};

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function formatDateYYYYMMDD(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function granularityExpr(granularity: RevenueQueryDTO["granularity"]): string {
  switch (granularity) {
    case "week":
      return "date_trunc('week', x.date_value)::date";
    case "year":
      return "date_trunc('year', x.date_value)::date";
    case "month":
    default:
      return "date_trunc('month', x.date_value)::date";
  }
}

export async function repoCommercialRevenue(query: RevenueQueryDTO): Promise<{ buckets: RevenueBucket[] }> {
  const periodExpr = granularityExpr(query.granularity);
  const wherePartsFacture: string[] = [];
  const wherePartsAvoir: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (!query.include_brouillon) {
    wherePartsFacture.push(`COALESCE(f.statut, '') <> 'brouillon'`);
    wherePartsAvoir.push(`COALESCE(a.statut, '') <> 'brouillon'`);
  }

  if (query.from) {
    const p = push(query.from);
    wherePartsFacture.push(`f.date_emission >= ${p}::date`);
    wherePartsAvoir.push(`a.date_emission >= ${p}::date`);
  }
  if (query.to) {
    const p = push(query.to);
    wherePartsFacture.push(`f.date_emission <= ${p}::date`);
    wherePartsAvoir.push(`a.date_emission <= ${p}::date`);
  }

  const whereFactureSql = wherePartsFacture.length ? `WHERE ${wherePartsFacture.join(" AND ")}` : "";
  const whereAvoirSql = wherePartsAvoir.length ? `WHERE ${wherePartsAvoir.join(" AND ")}` : "";

  const sql = `
    WITH x AS (
      SELECT
        f.date_emission AS date_value,
        f.total_ttc::float8 AS total_ttc,
        f.total_ht::float8 AS total_ht,
        1::int AS count_factures,
        0::int AS count_avoirs
      FROM facture f
      ${whereFactureSql}

      UNION ALL

      SELECT
        a.date_emission AS date_value,
        (-a.total_ttc::float8) AS total_ttc,
        (-a.total_ht::float8) AS total_ht,
        0::int AS count_factures,
        1::int AS count_avoirs
      FROM avoir a
      ${whereAvoirSql}
    )
    SELECT
      (${periodExpr})::text AS period,
      COALESCE(SUM(x.total_ttc), 0)::float8 AS total_ttc,
      COALESCE(SUM(x.total_ht), 0)::float8 AS total_ht,
      COALESCE(SUM(x.count_factures), 0)::int AS count_factures,
      COALESCE(SUM(x.count_avoirs), 0)::int AS count_avoirs
    FROM x
    GROUP BY (${periodExpr})
    ORDER BY (${periodExpr}) ASC
  `;

  const res = await pool.query<RevenueBucket>(sql, values);
  return { buckets: res.rows };
}

export async function repoCommercialOutstanding(query: OutstandingQueryDTO): Promise<OutstandingSummary> {
  const asOf = query.as_of ?? formatDateYYYYMMDD(new Date());
  const includeBrouillon = query.include_brouillon;

  const statusFilterSql = includeBrouillon ? "" : "WHERE COALESCE(f.statut, '') <> 'brouillon'";

  const summarySql = `
    WITH inv AS (
      SELECT
        f.id,
        f.numero,
        f.client_id,
        f.date_emission,
        f.date_echeance,
        f.total_ttc::float8 AS total_ttc,
        pay.total_paye_ttc,
        av.total_avoirs_ttc,
        GREATEST(0, f.total_ttc::float8 - pay.total_paye_ttc - av.total_avoirs_ttc) AS reste_a_payer_ttc
      FROM facture f
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(p.montant), 0)::float8 AS total_paye_ttc
        FROM paiement p
        WHERE p.facture_id = f.id
      ) pay ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(a.total_ttc), 0)::float8 AS total_avoirs_ttc
        FROM avoir a
        WHERE a.facture_id = f.id
          AND COALESCE(a.statut, '') <> 'brouillon'
      ) av ON TRUE
      ${statusFilterSql}
    )
    SELECT
      COALESCE(SUM(inv.reste_a_payer_ttc) FILTER (WHERE inv.reste_a_payer_ttc > 0), 0)::float8 AS outstanding_ttc,
      COALESCE(
        SUM(inv.reste_a_payer_ttc) FILTER (
          WHERE inv.reste_a_payer_ttc > 0
            AND COALESCE(inv.date_echeance, inv.date_emission) < $1::date
        ),
        0
      )::float8 AS overdue_ttc,
      COALESCE(COUNT(*) FILTER (WHERE inv.reste_a_payer_ttc > 0), 0)::int AS count_outstanding,
      COALESCE(
        COUNT(*) FILTER (
          WHERE inv.reste_a_payer_ttc > 0
            AND COALESCE(inv.date_echeance, inv.date_emission) < $1::date
        ),
        0
      )::int AS count_overdue
    FROM inv
  `;

  type SummaryRow = {
    outstanding_ttc: number;
    overdue_ttc: number;
    count_outstanding: number;
    count_overdue: number;
  };

  const summaryRes = await pool.query<SummaryRow>(summarySql, [asOf]);
  const summary = summaryRes.rows[0] ?? {
    outstanding_ttc: 0,
    overdue_ttc: 0,
    count_outstanding: 0,
    count_overdue: 0,
  };

  const overdueSql = `
    WITH inv AS (
      SELECT
        f.id,
        f.numero,
        f.client_id,
        f.date_emission,
        f.date_echeance,
        f.total_ttc::float8 AS total_ttc,
        pay.total_paye_ttc,
        av.total_avoirs_ttc,
        GREATEST(0, f.total_ttc::float8 - pay.total_paye_ttc - av.total_avoirs_ttc) AS reste_a_payer_ttc
      FROM facture f
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(p.montant), 0)::float8 AS total_paye_ttc
        FROM paiement p
        WHERE p.facture_id = f.id
      ) pay ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(a.total_ttc), 0)::float8 AS total_avoirs_ttc
        FROM avoir a
        WHERE a.facture_id = f.id
          AND COALESCE(a.statut, '') <> 'brouillon'
      ) av ON TRUE
      ${statusFilterSql}
    )
    SELECT
      inv.id::text AS id,
      inv.numero,
      inv.client_id,
      c.company_name,
      inv.date_emission::text AS date_emission,
      inv.date_echeance::text AS date_echeance,
      inv.total_ttc,
      inv.total_paye_ttc,
      inv.total_avoirs_ttc,
      inv.reste_a_payer_ttc
    FROM inv
    LEFT JOIN clients c ON c.client_id = inv.client_id
    WHERE inv.reste_a_payer_ttc > 0
      AND COALESCE(inv.date_echeance, inv.date_emission) < $1::date
    ORDER BY inv.reste_a_payer_ttc DESC, inv.id DESC
    LIMIT $2
  `;

  type OverdueRow = Omit<OutstandingRow, "id"> & { id: string };
  const overdueRes = await pool.query<OverdueRow>(overdueSql, [asOf, query.limit]);
  const overdue_invoices: OutstandingRow[] = overdueRes.rows.map((r) => ({
    ...r,
    id: toInt(r.id, "facture.id"),
  }));

  return {
    as_of: asOf,
    ...summary,
    overdue_invoices,
  };
}

export async function repoCommercialTopClients(query: TopClientsQueryDTO): Promise<{ items: TopClientRow[] }> {
  const whereFacture: string[] = [];
  const whereAvoir: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (!query.include_brouillon) {
    whereFacture.push(`COALESCE(f.statut, '') <> 'brouillon'`);
    whereAvoir.push(`COALESCE(a.statut, '') <> 'brouillon'`);
  }

  if (query.from) {
    const p = push(query.from);
    whereFacture.push(`f.date_emission >= ${p}::date`);
    whereAvoir.push(`a.date_emission >= ${p}::date`);
  }

  if (query.to) {
    const p = push(query.to);
    whereFacture.push(`f.date_emission <= ${p}::date`);
    whereAvoir.push(`a.date_emission <= ${p}::date`);
  }

  const whereFactureSql = whereFacture.length ? `WHERE ${whereFacture.join(" AND ")}` : "";
  const whereAvoirSql = whereAvoir.length ? `WHERE ${whereAvoir.join(" AND ")}` : "";

  const sql = `
    WITH amounts AS (
      SELECT
        f.client_id,
        f.total_ttc::float8 AS amount_ttc,
        1::int AS count_factures,
        0::int AS count_avoirs
      FROM facture f
      ${whereFactureSql}

      UNION ALL

      SELECT
        a.client_id,
        (-a.total_ttc::float8) AS amount_ttc,
        0::int AS count_factures,
        1::int AS count_avoirs
      FROM avoir a
      ${whereAvoirSql}
    )
    SELECT
      am.client_id,
      c.company_name,
      COALESCE(SUM(am.amount_ttc), 0)::float8 AS total_ttc,
      COALESCE(SUM(am.count_factures), 0)::int AS count_factures,
      COALESCE(SUM(am.count_avoirs), 0)::int AS count_avoirs
    FROM amounts am
    LEFT JOIN clients c ON c.client_id = am.client_id
    GROUP BY am.client_id, c.company_name
    ORDER BY total_ttc DESC
    LIMIT $${values.length + 1}
  `;

  const res = await pool.query<TopClientRow>(sql, [...values, query.limit]);
  return { items: res.rows };
}
