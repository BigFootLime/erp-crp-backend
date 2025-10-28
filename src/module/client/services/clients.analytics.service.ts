// src/module/clients/services/clients.analytics.service.ts
import pool from "../../../config/database"

type Params = { from?: string; to?: string; status?: string; blocked?: string; country?: string }

export async function getClientsAnalytics(p: Params) {
  const db = await pool.connect()
  try {
    const where: string[] = []
    const values: any[] = []
    let i = 1

    // dates: on filtre sur clients.creation_date (timestamp)
    if (p.from) { where.push(`c.creation_date::date >= $${i++}::date`); values.push(p.from) }
    if (p.to)   { where.push(`c.creation_date::date <= $${i++}::date`); values.push(p.to) }

    if (p.status && p.status !== "") {
      where.push(`c.status = $${i++}`); values.push(p.status)
    }

    if (typeof p.blocked !== "undefined" && p.blocked !== "" && p.blocked !== "all") {
      // "true" | "false"
      where.push(`c.blocked = $${i++}`); values.push(p.blocked === "true")
    }

    if (p.country && p.country.trim() !== "") {
      // on regarde dans bill puis livraison
      where.push(`COALESCE(bill.country, deliv.country) ILIKE $${i++}`)
      values.push(p.country.trim())
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

    // -- KPIs
    const kpisSql = `
      SELECT
        COUNT(*)::int                        AS total,
        SUM((c.status = 'client')::int)::int AS active,
        SUM((c.blocked IS TRUE)::int)::int   AS blocked,
        SUM((c.creation_date >= NOW() - INTERVAL '30 days')::int)::int AS new30d
      FROM clients c
      LEFT JOIN adresse_facturation bill ON bill.bill_address_id = c.bill_address_id
      LEFT JOIN adresse_livraison deliv ON deliv.delivery_address_id = c.delivery_address_id
      ${whereSql}
    `
    const { rows: [kpis] } = await db.query(kpisSql, values)

    // -- Séries par date (jour)
    const seriesDateSql = `
      SELECT to_char(d::date, 'YYYY-MM-DD') AS date, COUNT(c2.client_id)::int AS count
      FROM generate_series(
        COALESCE( (SELECT MIN(c.creation_date::date) FROM clients c), CURRENT_DATE ),
        CURRENT_DATE,
        '1 day'::interval
      ) AS d
      LEFT JOIN LATERAL (
        SELECT c.client_id
        FROM clients c
        LEFT JOIN adresse_facturation bill ON bill.bill_address_id = c.bill_address_id
        LEFT JOIN adresse_livraison deliv ON deliv.delivery_address_id = c.delivery_address_id
        WHERE c.creation_date::date = d::date
        ${where.length ? `AND ${where.join(" AND ")}` : ""}
      ) c2 ON TRUE
      GROUP BY d
      ORDER BY d
    `
    const { rows: byDate } = await db.query(seriesDateSql, values)

    // -- Répartition par pays
    const seriesCountrySql = `
      SELECT COALESCE(NULLIF(TRIM(COALESCE(bill.country, deliv.country)), ''), '—') AS country,
             COUNT(*)::int AS count
      FROM clients c
      LEFT JOIN adresse_facturation bill ON bill.bill_address_id = c.bill_address_id
      LEFT JOIN adresse_livraison deliv ON deliv.delivery_address_id = c.delivery_address_id
      ${whereSql}
      GROUP BY 1
      ORDER BY count DESC, country ASC
    `
    const { rows: byCountry } = await db.query(seriesCountrySql, values)

    return {
      kpis: {
        total: kpis?.total ?? 0,
        active: kpis?.active ?? 0,
        blocked: kpis?.blocked ?? 0,
        new30d: kpis?.new30d ?? 0,
      },
      series: {
        byDate,
        byCountry,
      },
    }
  } finally {
    db.release()
  }
}
