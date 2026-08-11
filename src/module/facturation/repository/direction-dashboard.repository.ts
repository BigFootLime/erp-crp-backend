import pool from "../../../config/database";
import { BL_SHIPPED_STATUSES, type Period } from "../domain/reporting-policy";
import {
  Params,
  balancesCte,
  creditedCte,
  ledgerFactureCte,
  settledCte,
} from "./reporting-sql";

export type DirectionRepositoryContext = {
  period: Period;
  asOf: string;
  siteId?: string;
  clientId?: string;
  currency?: string;
  limit: number;
};

type NullableMoney = number | null;

function nullableMoney(value: unknown): NullableMoney {
  if (value === null || value === undefined) return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type DirectionOrderRow = {
  commande_id: number;
  numero: string;
  client_id: string;
  company_name: string | null;
  currency: string | null;
  promised_date: string | null;
  earliest_remaining_due: string | null;
  current_status: string;
  remaining_ht: NullableMoney;
  remaining_lines: number;
  missing_price_lines: number;
  missing_due_lines: number;
  otif_eligible: boolean;
  otif_pass: boolean | null;
  risk_cause: DirectionRiskCause | null;
  risk_detail: string | null;
};

export type DirectionRiskCause =
  | "OVERDUE"
  | "WORKFLOW_BLOCKED"
  | "OF_PAUSED"
  | "PRODUCTION_LATE"
  | "NO_EXECUTION_PATH"
  | "MISSING_DUE_DATE";

export type DirectionOrderFacts = {
  totalOrders: number;
  mappedSiteOrders: number;
  missingCurrencyOrders: number;
  otif: { eligible: number; passed: number; missingDueOrders: number };
  riskOrders: number;
  delayedOrders: number;
  delayedMissingPriceOrders: number;
  delayedMissingCurrencyOrders: number;
  delayed: Array<{ currency: string; amount: number; orders: number }>;
  rows: DirectionOrderRow[];
  totalRows: number;
  causes: Array<{ cause: DirectionRiskCause; count: number }>;
  series: Array<{ week: string; eligible: number; passed: number; value: number | null }>;
};

/**
 * Faits commandes du cockpit Direction.
 *
 * Le filtre site est appliqué dans SQL sur le warehouse relié à une destination,
 * une réservation ou une allocation de livraison. Une commande sans preuve de site
 * n'est jamais injectée artificiellement dans un site.
 */
export async function repoDirectionOrders(ctx: DirectionRepositoryContext): Promise<DirectionOrderFacts> {
  const p = new Params();
  const shippedStatuses = p.push([...BL_SHIPPED_STATUSES]);
  const asOf = p.push(ctx.asOf);
  const from = p.push(ctx.period.from);
  const to = p.push(ctx.period.to);
  const riskHorizon = p.push(ctx.asOf);
  const limit = p.push(ctx.limit);
  const clientFilter = ctx.clientId ? `AND cc.client_id = ${p.push(ctx.clientId)}` : "";
  const currencyFilter = ctx.currency
    ? `AND UPPER(NULLIF(BTRIM(c.devise), '')) = ${p.push(ctx.currency)}`
    : "";
  const siteFilter = ctx.siteId
    ? `AND EXISTS (
        SELECT 1 FROM order_sites selected_site
        WHERE selected_site.commande_id = cc.id
          AND selected_site.site_id = ${p.push(ctx.siteId)}::uuid
      )`
    : "";

  const commonCtes = `
    order_sites AS (
      SELECT cc_site.id AS commande_id, m_dest.warehouse_id AS site_id
      FROM commande_client cc_site
      JOIN magasins m_dest ON m_dest.id = cc_site.dest_stock_magasin_id
      WHERE m_dest.warehouse_id IS NOT NULL
      UNION
      SELECT cl_site.commande_id, loc.warehouse_id
      FROM commande_ligne cl_site
      JOIN stock_reservations sr ON sr.commande_ligne_id = cl_site.id
      JOIN locations loc ON loc.id = sr.location_id
      WHERE loc.warehouse_id IS NOT NULL
      UNION
      SELECT cl_site.commande_id, m_alloc.warehouse_id
      FROM commande_ligne cl_site
      JOIN bon_livraison_ligne bll_site ON bll_site.commande_ligne_id = cl_site.id
      JOIN bon_livraison_ligne_allocations blla ON blla.bon_livraison_ligne_id = bll_site.id
      JOIN magasins m_alloc ON m_alloc.id = blla.magasin_id
      WHERE m_alloc.warehouse_id IS NOT NULL
    ),
    ship_daily AS (
      SELECT
        bll.commande_ligne_id,
        COALESCE(bl.date_expedition, bl.date_livraison, bl.date_creation)::date AS ship_date,
        SUM(bll.quantite)::numeric(18,3) AS shipped_qty
      FROM bon_livraison_ligne bll
      JOIN bon_livraison bl ON bl.id = bll.bon_livraison_id
      WHERE bll.commande_ligne_id IS NOT NULL
        AND bl.statut = ANY(${shippedStatuses}::text[])
        AND COALESCE(bl.date_expedition, bl.date_livraison, bl.date_creation)::date <= ${asOf}::date
      GROUP BY bll.commande_ligne_id, COALESCE(bl.date_expedition, bl.date_livraison, bl.date_creation)::date
    ),
    ship_progress AS (
      SELECT
        commande_ligne_id,
        ship_date,
        SUM(shipped_qty) OVER (
          PARTITION BY commande_ligne_id ORDER BY ship_date
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )::numeric(18,3) AS cumulative_qty
      FROM ship_daily
    ),
    shipment_by_line AS (
      SELECT
        cl_ship.id AS commande_ligne_id,
        COALESCE((SELECT SUM(sd.shipped_qty) FROM ship_daily sd WHERE sd.commande_ligne_id = cl_ship.id), 0)::numeric(18,3) AS shipped_qty,
        (
          SELECT MIN(sp.ship_date)
          FROM ship_progress sp
          WHERE sp.commande_ligne_id = cl_ship.id
            AND sp.cumulative_qty >= cl_ship.quantite
        ) AS completion_date
      FROM commande_ligne cl_ship
    ),
    reservation_by_line AS (
      SELECT
        sr.commande_ligne_id,
        SUM(sr.qty_reserved)::numeric(18,3) AS reserved_qty
      FROM stock_reservations sr
      WHERE sr.commande_ligne_id IS NOT NULL
        AND sr.status = 'ACTIVE'
        AND (sr.expires_at IS NULL OR sr.expires_at > (${asOf}::date + interval '1 day'))
      GROUP BY sr.commande_ligne_id
    ),
    of_by_line AS (
      SELECT
        COALESCE(ofs.commande_ligne_id, cl_of.id) AS commande_ligne_id,
        BOOL_OR(ofs.statut::text NOT IN ('ANNULE', 'CLOTURE')) AS has_active_of,
        BOOL_OR(ofs.statut::text = 'EN_PAUSE') AS has_paused_of,
        MAX(ofs.date_fin_prevue) FILTER (WHERE ofs.statut::text NOT IN ('ANNULE', 'CLOTURE')) AS latest_planned_end
      FROM commande_ligne cl_of
      JOIN ordres_fabrication ofs
        ON ofs.commande_ligne_id = cl_of.id
        OR (ofs.commande_ligne_id IS NULL AND ofs.commande_id = cl_of.commande_id)
      GROUP BY COALESCE(ofs.commande_ligne_id, cl_of.id)
    ),
    order_base AS (
      SELECT
        cc.id,
        cc.numero,
        cc.client_id,
        cc.date_commande::date AS order_date,
        c.company_name,
        UPPER(NULLIF(BTRIM(c.devise), '')) AS currency,
        COALESCE(latest.nouveau_statut, 'BROUILLON') AS current_status,
        EXISTS (SELECT 1 FROM order_sites os WHERE os.commande_id = cc.id) AS site_mapped
      FROM commande_client cc
      LEFT JOIN clients c ON c.client_id = cc.client_id
      LEFT JOIN LATERAL (
        SELECT ch.nouveau_statut
        FROM commande_historique ch
        WHERE ch.commande_id = cc.id
          AND ch.date_action < (${asOf}::date + interval '1 day')
        ORDER BY ch.date_action DESC, ch.id DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE COALESCE(cc.order_type, 'FERME') <> 'INTERNE'
        AND cc.date_commande::date <= ${asOf}::date
        ${clientFilter}
        ${currencyFilter}
        ${siteFilter}
    ),
    line_facts AS (
      SELECT
        ob.*,
        cl.id AS commande_ligne_id,
        cl.delai_client,
        cl.quantite::numeric(18,3) AS ordered_qty,
        GREATEST(cl.quantite - COALESCE(sbl.shipped_qty, 0), 0)::numeric(18,3) AS remaining_qty,
        CASE
          WHEN cl.prix_unitaire_ht IS NULL THEN NULL
          ELSE (
            GREATEST(cl.quantite - COALESCE(sbl.shipped_qty, 0), 0)
            * cl.prix_unitaire_ht
            * (1 - COALESCE(cl.remise_ligne, 0) / 100.0)
          )::numeric(18,2)
        END AS remaining_ht,
        sbl.completion_date,
        COALESCE(rbl.reserved_qty, 0)::numeric(18,3) AS reserved_qty,
        COALESCE(obl.has_active_of, false) AS has_active_of,
        COALESCE(obl.has_paused_of, false) AS has_paused_of,
        obl.latest_planned_end
      FROM order_base ob
      JOIN commande_ligne cl ON cl.commande_id = ob.id
      LEFT JOIN shipment_by_line sbl ON sbl.commande_ligne_id = cl.id
      LEFT JOIN reservation_by_line rbl ON rbl.commande_ligne_id = cl.id
      LEFT JOIN of_by_line obl ON obl.commande_ligne_id = cl.id
    ),
    order_facts AS (
      SELECT
        id,
        numero,
        client_id,
        company_name,
        currency,
        order_date,
        current_status,
        site_mapped,
        MAX(delai_client) AS promised_date,
        MIN(delai_client) FILTER (WHERE remaining_qty > 0) AS earliest_remaining_due,
        COUNT(*)::int AS line_count,
        COUNT(*) FILTER (WHERE delai_client IS NULL)::int AS missing_due_lines,
        COUNT(*) FILTER (WHERE remaining_qty > 0)::int AS remaining_lines,
        COUNT(*) FILTER (WHERE remaining_qty > 0 AND remaining_ht IS NULL)::int AS missing_price_lines,
        SUM(remaining_ht) FILTER (WHERE remaining_qty > 0)::numeric(18,2) AS remaining_ht,
        COUNT(*) FILTER (
          WHERE remaining_qty > 0 AND delai_client < ${riskHorizon}::date AND remaining_ht IS NULL
        )::int AS missing_overdue_price_lines,
        SUM(remaining_ht) FILTER (
          WHERE remaining_qty > 0 AND delai_client < ${riskHorizon}::date
        )::numeric(18,2) AS overdue_remaining_ht,
        BOOL_AND(delai_client IS NOT NULL) AS otif_eligible,
        BOOL_AND(
          delai_client IS NOT NULL
          AND completion_date IS NOT NULL
          AND completion_date <= delai_client
        ) AS otif_pass,
        BOOL_OR(remaining_qty > 0 AND delai_client IS NOT NULL AND delai_client < ${riskHorizon}::date) AS is_overdue,
        BOOL_OR(remaining_qty > 0 AND has_paused_of) AS has_paused_of,
        BOOL_OR(
          remaining_qty > 0
          AND delai_client IS NOT NULL
          AND latest_planned_end IS NOT NULL
          AND latest_planned_end > delai_client
        ) AS production_late,
        BOOL_OR(
          remaining_qty > 0
          AND delai_client BETWEEN ${riskHorizon}::date AND (${riskHorizon}::date + 7)
          AND NOT has_active_of
          AND reserved_qty < remaining_qty
        ) AS no_execution_path
      FROM line_facts
      GROUP BY id, numero, client_id, company_name, currency, order_date, current_status, site_mapped
    ),
    classified AS (
      SELECT
        ofa.*,
        CASE
          WHEN remaining_lines <= 0 OR current_status = 'ARCHIVE' THEN NULL
          WHEN is_overdue THEN 'OVERDUE'
          WHEN current_status = 'BLOQUE' THEN 'WORKFLOW_BLOCKED'
          WHEN has_paused_of THEN 'OF_PAUSED'
          WHEN production_late THEN 'PRODUCTION_LATE'
          WHEN no_execution_path THEN 'NO_EXECUTION_PATH'
          WHEN missing_due_lines > 0 THEN 'MISSING_DUE_DATE'
          ELSE NULL
        END AS risk_cause
      FROM order_facts ofa
    )`;

  const sql = `
    WITH ${commonCtes},
    selected AS (
      SELECT *
      FROM classified
      WHERE promised_date BETWEEN ${from}::date AND ${to}::date
         OR earliest_remaining_due BETWEEN ${from}::date AND ${to}::date
         OR (missing_due_lines > 0 AND order_date BETWEEN ${from}::date AND ${to}::date)
    ),
    delayed_by_currency AS (
      SELECT currency, SUM(overdue_remaining_ht)::numeric(18,2)::text AS amount, COUNT(*)::int AS orders
      FROM selected
      WHERE is_overdue AND currency IS NOT NULL AND missing_overdue_price_lines = 0
      GROUP BY currency
    ),
    ranked AS (
      SELECT *, COUNT(*) OVER()::int AS total_rows
      FROM selected
      WHERE risk_cause IS NOT NULL
         OR (otif_eligible AND promised_date BETWEEN ${from}::date AND ${to}::date)
      ORDER BY
        CASE risk_cause
          WHEN 'OVERDUE' THEN 1
          WHEN 'WORKFLOW_BLOCKED' THEN 2
          WHEN 'OF_PAUSED' THEN 3
          WHEN 'PRODUCTION_LATE' THEN 4
          WHEN 'NO_EXECUTION_PATH' THEN 5
          WHEN 'MISSING_DUE_DATE' THEN 6
          ELSE 7
        END,
        earliest_remaining_due NULLS LAST,
        id DESC
      LIMIT ${limit}
    )
    SELECT
      (SELECT COUNT(*) FROM selected)::int AS total_orders,
      (SELECT COUNT(*) FROM selected WHERE site_mapped)::int AS mapped_site_orders,
      (SELECT COUNT(*) FROM selected WHERE currency IS NULL)::int AS missing_currency_orders,
      (SELECT COUNT(*) FROM selected WHERE otif_eligible AND promised_date BETWEEN ${from}::date AND ${to}::date)::int AS otif_eligible,
      (SELECT COUNT(*) FROM selected WHERE otif_eligible AND otif_pass AND promised_date BETWEEN ${from}::date AND ${to}::date)::int AS otif_passed,
      (SELECT COUNT(*) FROM selected WHERE NOT otif_eligible AND promised_date BETWEEN ${from}::date AND ${to}::date)::int AS otif_missing_due_orders,
      (SELECT COUNT(*) FROM selected WHERE risk_cause IS NOT NULL)::int AS risk_orders,
      (SELECT COUNT(*) FROM selected WHERE is_overdue)::int AS delayed_orders,
      (SELECT COUNT(*) FROM selected WHERE is_overdue AND missing_overdue_price_lines > 0)::int AS delayed_missing_price_orders,
      (SELECT COUNT(*) FROM selected WHERE is_overdue AND currency IS NULL)::int AS delayed_missing_currency_orders,
      COALESCE((SELECT json_agg(dbc ORDER BY currency) FROM delayed_by_currency dbc), '[]'::json) AS delayed,
      COALESCE((
        SELECT json_agg(cause_row ORDER BY cause_row.count DESC, cause_row.cause)
        FROM (
          SELECT risk_cause AS cause, COUNT(*)::int AS count
          FROM selected WHERE risk_cause IS NOT NULL
          GROUP BY risk_cause
        ) cause_row
      ), '[]'::json) AS causes,
      COALESCE((
        SELECT json_agg(detail_row)
        FROM (
          SELECT
            id::text AS commande_id,
            numero,
            client_id,
            company_name,
            currency,
            promised_date::text,
            earliest_remaining_due::text,
            current_status,
            remaining_ht::text,
            remaining_lines,
            missing_price_lines,
            missing_due_lines,
            otif_eligible,
            CASE WHEN otif_eligible THEN otif_pass ELSE NULL END AS otif_pass,
            risk_cause,
            CASE risk_cause
              WHEN 'OVERDUE' THEN 'Échéance client dépassée avec quantité non expédiée.'
              WHEN 'WORKFLOW_BLOCKED' THEN 'Workflow de commande bloqué.'
              WHEN 'OF_PAUSED' THEN 'Au moins un OF lié est en pause.'
              WHEN 'PRODUCTION_LATE' THEN 'La fin prévue d’un OF dépasse le délai client.'
              WHEN 'NO_EXECUTION_PATH' THEN 'Échéance sous 7 jours sans OF actif ni réservation suffisante.'
              WHEN 'MISSING_DUE_DATE' THEN 'Au moins une ligne ouverte n’a pas de délai client.'
              ELSE NULL
            END AS risk_detail,
            total_rows
          FROM ranked
        ) detail_row
      ), '[]'::json) AS rows
  `;

  const result = await pool.query(sql, p.values);
  const row = result.rows[0] ?? {};
  const rawRows = Array.isArray(row.rows) ? row.rows : [];

  const seriesParams = new Params();
  const seriesStatuses = seriesParams.push([...BL_SHIPPED_STATUSES]);
  const seriesAsOf = seriesParams.push(ctx.asOf);
  const seriesClient = ctx.clientId ? `AND cc.client_id = ${seriesParams.push(ctx.clientId)}` : "";
  const seriesCurrency = ctx.currency
    ? `AND UPPER(NULLIF(BTRIM(c.devise), '')) = ${seriesParams.push(ctx.currency)}`
    : "";
  const seriesSite = ctx.siteId ? seriesParams.push(ctx.siteId) : null;
  const seriesSql = `
    WITH weeks AS (
      SELECT generate_series(
        date_trunc('week', ${seriesAsOf}::date) - interval '11 weeks',
        date_trunc('week', ${seriesAsOf}::date),
        interval '1 week'
      )::date AS week
    ),
    shipped_daily AS (
      SELECT bll.commande_ligne_id,
             COALESCE(bl.date_expedition, bl.date_livraison, bl.date_creation)::date AS ship_date,
             SUM(bll.quantite)::numeric(18,3) AS qty
      FROM bon_livraison_ligne bll
      JOIN bon_livraison bl ON bl.id = bll.bon_livraison_id
      WHERE bll.commande_ligne_id IS NOT NULL
        AND bl.statut = ANY(${seriesStatuses}::text[])
        AND COALESCE(bl.date_expedition, bl.date_livraison, bl.date_creation)::date <= ${seriesAsOf}::date
      GROUP BY bll.commande_ligne_id, COALESCE(bl.date_expedition, bl.date_livraison, bl.date_creation)::date
    ),
    progress AS (
      SELECT commande_ligne_id, ship_date,
             SUM(qty) OVER (PARTITION BY commande_ligne_id ORDER BY ship_date) AS cumulative_qty
      FROM shipped_daily
    ),
    lines AS (
      SELECT cc.id AS commande_id, MAX(cl.delai_client) OVER (PARTITION BY cc.id) AS promised_date,
             cl.delai_client,
             (SELECT MIN(pr.ship_date) FROM progress pr
              WHERE pr.commande_ligne_id = cl.id AND pr.cumulative_qty >= cl.quantite) AS completion_date
      FROM commande_client cc
      JOIN commande_ligne cl ON cl.commande_id = cc.id
      LEFT JOIN clients c ON c.client_id = cc.client_id
      WHERE COALESCE(cc.order_type, 'FERME') <> 'INTERNE'
        ${seriesClient}
        ${seriesCurrency}
        ${seriesSite ? `AND EXISTS (
          SELECT 1
          FROM commande_ligne cl_site
          LEFT JOIN stock_reservations sr_site ON sr_site.commande_ligne_id = cl_site.id
          LEFT JOIN locations loc_site ON loc_site.id = sr_site.location_id
          LEFT JOIN magasins m_dest ON m_dest.id = cc.dest_stock_magasin_id
          LEFT JOIN bon_livraison_ligne bll_site ON bll_site.commande_ligne_id = cl_site.id
          LEFT JOIN bon_livraison_ligne_allocations blla_site
            ON blla_site.bon_livraison_ligne_id = bll_site.id
          LEFT JOIN magasins m_alloc ON m_alloc.id = blla_site.magasin_id
          WHERE cl_site.commande_id = cc.id
            AND ${seriesSite}::uuid IN (
              loc_site.warehouse_id,
              m_dest.warehouse_id,
              m_alloc.warehouse_id
            )
        )` : ""}
    ),
    orders AS (
      SELECT commande_id, promised_date,
             BOOL_AND(delai_client IS NOT NULL) AS eligible,
             BOOL_AND(delai_client IS NOT NULL AND completion_date IS NOT NULL AND completion_date <= delai_client) AS passed
      FROM lines GROUP BY commande_id, promised_date
    ),
    weekly AS (
      SELECT date_trunc('week', promised_date)::date AS week,
             COUNT(*) FILTER (WHERE eligible)::int AS eligible,
             COUNT(*) FILTER (WHERE eligible AND passed)::int AS passed
      FROM orders
      WHERE promised_date >= date_trunc('week', ${seriesAsOf}::date) - interval '11 weeks'
        AND promised_date < date_trunc('week', ${seriesAsOf}::date) + interval '1 week'
      GROUP BY date_trunc('week', promised_date)::date
    )
    SELECT w.week::text, COALESCE(wk.eligible, 0)::int AS eligible,
           COALESCE(wk.passed, 0)::int AS passed
    FROM weeks w LEFT JOIN weekly wk ON wk.week = w.week
    ORDER BY w.week
  `;
  const seriesResult = await pool.query(seriesSql, seriesParams.values);

  return {
    totalOrders: integer(row.total_orders),
    mappedSiteOrders: integer(row.mapped_site_orders),
    missingCurrencyOrders: integer(row.missing_currency_orders),
    otif: {
      eligible: integer(row.otif_eligible),
      passed: integer(row.otif_passed),
      missingDueOrders: integer(row.otif_missing_due_orders),
    },
    riskOrders: integer(row.risk_orders),
    delayedOrders: integer(row.delayed_orders),
    delayedMissingPriceOrders: integer(row.delayed_missing_price_orders),
    delayedMissingCurrencyOrders: integer(row.delayed_missing_currency_orders),
    delayed: (Array.isArray(row.delayed) ? row.delayed : []).map((item: Record<string, unknown>) => ({
      currency: String(item.currency),
      amount: nullableMoney(item.amount) ?? 0,
      orders: integer(item.orders),
    })),
    causes: (Array.isArray(row.causes) ? row.causes : []).map((item: Record<string, unknown>) => ({
      cause: String(item.cause) as DirectionRiskCause,
      count: integer(item.count),
    })),
    rows: rawRows.map((item: Record<string, unknown>) => ({
      commande_id: integer(item.commande_id),
      numero: String(item.numero),
      client_id: String(item.client_id),
      company_name: item.company_name === null ? null : String(item.company_name),
      currency: item.currency === null ? null : String(item.currency),
      promised_date: item.promised_date === null ? null : String(item.promised_date),
      earliest_remaining_due:
        item.earliest_remaining_due === null ? null : String(item.earliest_remaining_due),
      current_status: String(item.current_status),
      remaining_ht: nullableMoney(item.remaining_ht),
      remaining_lines: integer(item.remaining_lines),
      missing_price_lines: integer(item.missing_price_lines),
      missing_due_lines: integer(item.missing_due_lines),
      otif_eligible: Boolean(item.otif_eligible),
      otif_pass: item.otif_pass === null ? null : Boolean(item.otif_pass),
      risk_cause: item.risk_cause === null ? null : (String(item.risk_cause) as DirectionRiskCause),
      risk_detail: item.risk_detail === null ? null : String(item.risk_detail),
    })),
    totalRows: rawRows.length > 0 ? integer(rawRows[0]?.total_rows) : 0,
    series: seriesResult.rows.map((item) => {
      const eligible = integer(item.eligible);
      const passed = integer(item.passed);
      return {
        week: String(item.week),
        eligible,
        passed,
        value: eligible > 0 ? Math.round((passed / eligible) * 10_000) / 100 : null,
      };
    }),
  };
}

export type DirectionCashFacts = {
  missingDueInvoices: number;
  currencies: Array<{ currency: string; amount: number; invoices: number }>;
  invoices: Array<{
    id: number;
    numero: string;
    client_id: string;
    company_name: string | null;
    currency: string;
    due_date: string;
    balance_ttc: number;
  }>;
  totalInvoices: number;
};

export async function repoDirectionCash(ctx: DirectionRepositoryContext): Promise<DirectionCashFacts> {
  const p = new Params();
  const ledger = ledgerFactureCte(p, {
    asOf: ctx.asOf,
    basis: "document_date",
    clientId: ctx.clientId,
    currency: ctx.currency,
  });
  const settled = settledCte(p, ctx.asOf);
  const credited = creditedCte(p, ctx.asOf, "document_date");
  const asOf = p.push(ctx.asOf);
  const limit = p.push(ctx.limit);
  const sql = `
    WITH ${ledger},
    ${settled},
    ${credited},
    ${balancesCte()},
    expected AS (
      SELECT b.*
      FROM balances b
      WHERE b.balance_ttc > 0
        AND b.date_echeance IS NOT NULL
        AND b.date_echeance BETWEEN ${asOf}::date AND (${asOf}::date + 30)
    ),
    ranked AS (
      SELECT e.*, COUNT(*) OVER()::int AS total_invoices
      FROM expected e
      ORDER BY e.date_echeance, e.balance_ttc DESC, e.id DESC
      LIMIT ${limit}
    )
    SELECT
      (SELECT COUNT(*) FROM balances b WHERE b.balance_ttc > 0 AND b.date_echeance IS NULL)::int AS missing_due_invoices,
      COALESCE((
        SELECT json_agg(currency_row ORDER BY currency_row.currency)
        FROM (
          SELECT currency, SUM(balance_ttc)::numeric(18,2)::text AS amount, COUNT(*)::int AS invoices
          FROM expected GROUP BY currency
        ) currency_row
      ), '[]'::json) AS currencies,
      COALESCE((
        SELECT json_agg(invoice_row)
        FROM (
          SELECT r.id::text, r.numero, r.client_id, c.company_name, r.currency,
                 r.date_echeance::text AS due_date, r.balance_ttc::text, r.total_invoices
          FROM ranked r
          LEFT JOIN clients c ON c.client_id = r.client_id
          ORDER BY r.date_echeance, r.balance_ttc DESC, r.id DESC
        ) invoice_row
      ), '[]'::json) AS invoices
  `;
  const result = await pool.query(sql, p.values);
  const row = result.rows[0] ?? {};
  const invoices = Array.isArray(row.invoices) ? row.invoices : [];
  return {
    missingDueInvoices: integer(row.missing_due_invoices),
    currencies: (Array.isArray(row.currencies) ? row.currencies : []).map(
      (item: Record<string, unknown>) => ({
        currency: String(item.currency),
        amount: nullableMoney(item.amount) ?? 0,
        invoices: integer(item.invoices),
      })
    ),
    invoices: invoices.map((item: Record<string, unknown>) => ({
      id: integer(item.id),
      numero: String(item.numero),
      client_id: String(item.client_id),
      company_name: item.company_name === null ? null : String(item.company_name),
      currency: String(item.currency),
      due_date: String(item.due_date),
      balance_ttc: nullableMoney(item.balance_ttc) ?? 0,
    })),
    totalInvoices: invoices.length > 0 ? integer(invoices[0]?.total_invoices) : 0,
  };
}

export type DirectionFilterOptions = {
  sites: Array<{ id: string; code: string; name: string }>;
  clients: Array<{ id: string; name: string }>;
  currencies: string[];
  truncated: {
    sites: boolean;
    clients: boolean;
    currencies: boolean;
  };
};

export async function repoDirectionFilterOptions(): Promise<DirectionFilterOptions> {
  const [sites, clients, currencies] = await Promise.all([
    pool.query(
      `SELECT id::text, code::text, name::text
       FROM warehouses
       ORDER BY code
       LIMIT 201`
    ),
    pool.query(
      `SELECT client_id::text AS id, company_name::text AS name
       FROM clients
       WHERE company_name IS NOT NULL AND BTRIM(company_name) <> ''
       ORDER BY company_name
       LIMIT 501`
    ),
    pool.query(
      `SELECT DISTINCT UPPER(currency) AS currency
       FROM (
         SELECT currency FROM facture
         UNION ALL
         SELECT devise AS currency FROM clients
       ) known_currencies
       WHERE currency IS NOT NULL AND BTRIM(currency) <> ''
       ORDER BY 1
       LIMIT 51`
    ),
  ]);
  return {
    sites: sites.rows.slice(0, 200).map((row) => ({ id: String(row.id), code: String(row.code), name: String(row.name) })),
    clients: clients.rows.slice(0, 500).map((row) => ({ id: String(row.id), name: String(row.name) })),
    currencies: currencies.rows.slice(0, 50).map((row) => String(row.currency)),
    truncated: {
      sites: sites.rows.length > 200,
      clients: clients.rows.length > 500,
      currencies: currencies.rows.length > 50,
    },
  };
}
