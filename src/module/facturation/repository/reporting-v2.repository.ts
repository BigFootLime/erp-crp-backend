// Reporting commercial 360 (#275) — agrégats serveur.
//
// Règles tenues dans TOUT ce fichier :
//   - chaque somme monétaire est faite en NUMERIC puis rendue en `text` ;
//   - chaque requête est bornée (période, `as_of`, LIMIT explicite) ;
//   - aucun agrégat ne mélange deux devises ;
//   - un dénominateur nul rend `null`, jamais 0 ;
//   - une donnée absente est signalée, jamais remplacée par 0.

import pool from "../../../config/database";
import {
  AVOIR_LEDGER_STATUSES,
  BL_DELIVERED_STATUSES,
  BL_SHIPPED_STATUSES,
  DEVIS_DECIDED_STATUSES,
  FACTURE_LEDGER_STATUSES,
  truncExpression,
  type DateBasis,
  type Granularity,
  type Period,
} from "../domain/reporting-policy";
import {
  AGING_BUCKETS,
  Params,
  agingBucketExpression,
  balancesCte,
  count,
  creditedCte,
  ledgerAvoirCte,
  ledgerFactureCte,
  lineValueExpression,
  money,
  paiementAllocatedAmountExpression,
  paiementAvailableAmountExpression,
  paiementNetPredicate,
  paiementProjectedStatusExpression,
  ratio,
  settledCte,
  shippedLinesCte,
} from "./reporting-sql";

export type ReportingContext = {
  period: Period;
  asOf: string;
  basis: DateBasis;
  granularity: Granularity;
  clientId?: string;
  currency?: string;
  orderType?: "FERME" | "CADRE" | "INTERNE";
  commercialId?: number;
  affaireId?: number;
  famille?: string;
  limit: number;
};

export type SeriesPoint = {
  period: string;
  value: number;
  secondary?: number;
  count?: number;
};

export type Anomaly = {
  code: string;
  label: string;
  count: number;
  severity: "info" | "warning";
  hint: string;
};

// ---------------------------------------------------------------------------
// Devis
// ---------------------------------------------------------------------------

export type QuotesSummary = {
  issued_count: number;
  issued_amount_ht: number;
  won_count: number;
  won_amount_ht: number;
  lost_count: number;
  lost_amount_ht: number;
  expired_count: number;
  pending_count: number;
  pending_amount_ht: number;
  decision_rate: number | null;
  win_rate: number | null;
  open_count: number;
  open_amount_ht: number;
  open_stale_count: number;
  series: SeriesPoint[];
  top_open: Array<{
    id: number;
    numero: string;
    client_id: string;
    company_name: string | null;
    total_ht: number;
    date_creation: string;
    date_validite: string | null;
    stale: boolean;
  }>;
  top_open_truncated: boolean;
};

function quoteScope(p: Params, ctx: ReportingContext, bounded: boolean): string[] {
  const where: string[] = [`d.statut <> ALL(${p.push(["BROUILLON", "ANNULE"])}::text[])`];
  if (bounded) {
    where.push(`d.date_creation::date >= ${p.push(ctx.period.from)}::date`);
    where.push(`d.date_creation::date <= ${p.push(ctx.period.to)}::date`);
  }
  if (ctx.clientId) where.push(`d.client_id = ${p.push(ctx.clientId)}`);
  if (ctx.commercialId) where.push(`d.user_id = ${p.push(ctx.commercialId)}`);
  return where;
}

export async function repoQuotes(ctx: ReportingContext): Promise<QuotesSummary> {
  const p = new Params();
  const scope = quoteScope(p, ctx, true);
  const decided = p.push([...DEVIS_DECIDED_STATUSES]);

  const summarySql = `
    WITH q AS (
      SELECT d.id, d.statut, d.total_ht::numeric(18,2) AS total_ht
      FROM devis d
      WHERE ${scope.join("\n        AND ")}
    )
    SELECT
      COUNT(*)::int AS issued_count,
      COALESCE(SUM(total_ht), 0)::numeric(18,2)::text AS issued_amount_ht,
      COUNT(*) FILTER (WHERE statut = 'ACCEPTE')::int AS won_count,
      COALESCE(SUM(total_ht) FILTER (WHERE statut = 'ACCEPTE'), 0)::numeric(18,2)::text AS won_amount_ht,
      COUNT(*) FILTER (WHERE statut = 'REFUSE')::int AS lost_count,
      COALESCE(SUM(total_ht) FILTER (WHERE statut = 'REFUSE'), 0)::numeric(18,2)::text AS lost_amount_ht,
      COUNT(*) FILTER (WHERE statut = 'EXPIRE')::int AS expired_count,
      COUNT(*) FILTER (WHERE statut = 'ENVOYE')::int AS pending_count,
      COALESCE(SUM(total_ht) FILTER (WHERE statut = 'ENVOYE'), 0)::numeric(18,2)::text AS pending_amount_ht,
      COUNT(*) FILTER (WHERE statut = ANY(${decided}::text[]))::int AS decided_count
    FROM q
  `;
  const summaryRes = await pool.query(summarySql, p.values);
  const row = summaryRes.rows[0] ?? {};

  const issuedCount = count(row.issued_count);
  const decidedCount = count(row.decided_count);
  const wonCount = count(row.won_count);

  // Série : cohortes de création, même périmètre que le total.
  const sp = new Params();
  const seriesScope = quoteScope(sp, ctx, true);
  const bucket = truncExpression(ctx.granularity, "d.date_creation");
  const seriesSql = `
    SELECT
      (${bucket})::text AS period,
      COALESCE(SUM(d.total_ht), 0)::numeric(18,2)::text AS value,
      COALESCE(SUM(d.total_ht) FILTER (WHERE d.statut = 'ACCEPTE'), 0)::numeric(18,2)::text AS secondary,
      COUNT(*)::int AS bucket_count
    FROM devis d
    WHERE ${seriesScope.join("\n      AND ")}
    GROUP BY (${bucket})
    ORDER BY (${bucket}) ASC
  `;
  const seriesRes = await pool.query(seriesSql, sp.values);

  // Portefeuille ouvert : photographie de l'état courant, hors période.
  const op = new Params();
  const openScope = quoteScope(op, ctx, false);
  openScope.push(`d.statut = 'ENVOYE'`);
  const openAsOf = op.push(ctx.asOf);
  const openLimit = op.push(ctx.limit);
  const openSql = `
    WITH o AS (
      SELECT
        d.id, d.numero, d.client_id, d.total_ht::numeric(18,2) AS total_ht,
        d.date_creation, d.date_validite,
        (d.date_validite IS NOT NULL AND d.date_validite < ${openAsOf}::date) AS stale
      FROM devis d
      WHERE ${openScope.join("\n        AND ")}
    )
    SELECT
      (SELECT COUNT(*) FROM o)::int AS open_count,
      (SELECT COALESCE(SUM(total_ht), 0) FROM o)::numeric(18,2)::text AS open_amount_ht,
      (SELECT COUNT(*) FROM o WHERE stale)::int AS open_stale_count,
      (
        SELECT COALESCE(json_agg(x ORDER BY x.total_ht DESC), '[]'::json)
        FROM (
          SELECT o.id::text AS id, o.numero, o.client_id, c.company_name,
                 o.total_ht::text AS total_ht,
                 o.date_creation::date::text AS date_creation,
                 o.date_validite::text AS date_validite,
                 o.stale
          FROM o
          LEFT JOIN clients c ON c.client_id = o.client_id
          ORDER BY o.total_ht DESC, o.id DESC
          LIMIT ${openLimit}
        ) x
      ) AS top_open
  `;
  const openRes = await pool.query(openSql, op.values);
  const openRow = openRes.rows[0] ?? {};
  const topOpen = Array.isArray(openRow.top_open) ? openRow.top_open : [];

  return {
    issued_count: issuedCount,
    issued_amount_ht: money(row.issued_amount_ht),
    won_count: wonCount,
    won_amount_ht: money(row.won_amount_ht),
    lost_count: count(row.lost_count),
    lost_amount_ht: money(row.lost_amount_ht),
    expired_count: count(row.expired_count),
    pending_count: count(row.pending_count),
    pending_amount_ht: money(row.pending_amount_ht),
    decision_rate: ratio(decidedCount, issuedCount),
    win_rate: ratio(wonCount, decidedCount),
    open_count: count(openRow.open_count),
    open_amount_ht: money(openRow.open_amount_ht),
    open_stale_count: count(openRow.open_stale_count),
    series: seriesRes.rows.map((r) => ({
      period: String(r.period),
      value: money(r.value),
      secondary: money(r.secondary),
      count: count(r.bucket_count),
    })),
    top_open: topOpen.map((r: Record<string, unknown>) => ({
      id: Number.parseInt(String(r.id), 10),
      numero: String(r.numero),
      client_id: String(r.client_id),
      company_name: (r.company_name as string | null) ?? null,
      total_ht: money(r.total_ht),
      date_creation: String(r.date_creation),
      date_validite: (r.date_validite as string | null) ?? null,
      stale: Boolean(r.stale),
    })),
    top_open_truncated: count(openRow.open_count) > topOpen.length,
  };
}

// ---------------------------------------------------------------------------
// Commandes et carnet
// ---------------------------------------------------------------------------

export type OrdersSummary = {
  booked_count: number;
  booked_amount_ht: number;
  internal_count: number;
  internal_amount_ht: number;
  average_order_ht: number | null;
  backlog_amount_ht: number;
  backlog_lines: number;
  backlog_to_invoice_ht: number;
  overdue_lines: number;
  overdue_amount_ht: number;
  undated_lines: number;
  series: SeriesPoint[];
  by_type: Array<{ order_type: string; count: number; amount_ht: number }>;
  top_backlog: Array<{
    commande_id: number;
    numero: string;
    client_id: string;
    company_name: string | null;
    remaining_ht: number;
    earliest_due: string | null;
    late: boolean;
  }>;
  top_backlog_truncated: boolean;
};

function orderScope(p: Params, ctx: ReportingContext, bounded: boolean, alias = "cc"): string[] {
  const where: string[] = [];
  if (bounded) {
    where.push(`${alias}.date_commande >= ${p.push(ctx.period.from)}::date`);
    where.push(`${alias}.date_commande <= ${p.push(ctx.period.to)}::date`);
  }
  if (ctx.clientId) where.push(`${alias}.client_id = ${p.push(ctx.clientId)}`);
  if (ctx.orderType) where.push(`COALESCE(${alias}.order_type, 'FERME') = ${p.push(ctx.orderType)}`);
  return where;
}

export async function repoOrders(ctx: ReportingContext): Promise<OrdersSummary> {
  const p = new Params();
  const scope = orderScope(p, ctx, true);
  const whereSql = scope.length ? `WHERE ${scope.join("\n        AND ")}` : "";

  const summarySql = `
    WITH oc AS (
      SELECT cc.id, COALESCE(cc.order_type, 'FERME') AS order_type,
             cc.total_ht::numeric(18,2) AS total_ht
      FROM commande_client cc
      ${whereSql}
    )
    SELECT
      COUNT(*) FILTER (WHERE order_type <> 'INTERNE')::int AS booked_count,
      COALESCE(SUM(total_ht) FILTER (WHERE order_type <> 'INTERNE'), 0)::numeric(18,2)::text AS booked_amount_ht,
      COUNT(*) FILTER (WHERE order_type = 'INTERNE')::int AS internal_count,
      COALESCE(SUM(total_ht) FILTER (WHERE order_type = 'INTERNE'), 0)::numeric(18,2)::text AS internal_amount_ht
    FROM oc
  `;
  const summaryRes = await pool.query(summarySql, p.values);
  const row = summaryRes.rows[0] ?? {};

  const tp = new Params();
  const typeScope = orderScope(tp, ctx, true);
  const typeWhere = typeScope.length ? `WHERE ${typeScope.join(" AND ")}` : "";
  const byTypeRes = await pool.query(
    `SELECT COALESCE(cc.order_type, 'FERME') AS order_type,
            COUNT(*)::int AS count,
            COALESCE(SUM(cc.total_ht), 0)::numeric(18,2)::text AS amount_ht
     FROM commande_client cc ${typeWhere}
     GROUP BY COALESCE(cc.order_type, 'FERME')
     ORDER BY 1`,
    tp.values
  );

  const sp = new Params();
  const seriesScope = orderScope(sp, ctx, true);
  seriesScope.push(`COALESCE(cc.order_type, 'FERME') <> 'INTERNE'`);
  const bucket = truncExpression(ctx.granularity, "cc.date_commande");
  const seriesRes = await pool.query(
    `SELECT (${bucket})::text AS period,
            COALESCE(SUM(cc.total_ht), 0)::numeric(18,2)::text AS value,
            COUNT(*)::int AS bucket_count
     FROM commande_client cc
     WHERE ${seriesScope.join(" AND ")}
     GROUP BY (${bucket}) ORDER BY (${bucket}) ASC`,
    sp.values
  );

  // Carnet : quantités de lignes, jamais un statut d'en-tête. Borné à `as_of`.
  const bp = new Params();
  const shipped = shippedLinesCte(bp, ctx.asOf);
  const backlogScope = orderScope(bp, ctx, false);
  backlogScope.push(`COALESCE(cc.order_type, 'FERME') <> 'INTERNE'`);
  if (ctx.affaireId) {
    backlogScope.push(
      `EXISTS (SELECT 1 FROM commande_to_affaire cta WHERE cta.commande_id = cc.id AND cta.affaire_id = ${bp.push(ctx.affaireId)})`
    );
  }
  if (ctx.famille) backlogScope.push(`cl.famille = ${bp.push(ctx.famille)}`);
  const backlogAsOf = bp.push(ctx.asOf);
  const backlogLimit = bp.push(ctx.limit);

  const remainingQty = `GREATEST(cl.quantite - COALESCE(sl.quantite_expediee, 0), 0)`;
  const backlogSql = `
    WITH ${shipped},
    lines AS (
      SELECT
        cl.id AS commande_ligne_id,
        cc.id AS commande_id,
        cc.numero,
        cc.client_id,
        cl.delai_client,
        ${remainingQty}::numeric(18,3) AS quantite_restante,
        ${lineValueExpression(remainingQty)} AS remaining_ht
      FROM commande_ligne cl
      JOIN commande_client cc ON cc.id = cl.commande_id
      LEFT JOIN shipped_lines sl ON sl.commande_ligne_id = cl.id
      ${backlogScope.length ? `WHERE ${backlogScope.join("\n        AND ")}` : ""}
    ),
    open_lines AS (SELECT * FROM lines WHERE quantite_restante > 0)
    SELECT
      (SELECT COALESCE(SUM(remaining_ht), 0) FROM open_lines)::numeric(18,2)::text AS backlog_amount_ht,
      (SELECT COUNT(*) FROM open_lines)::int AS backlog_lines,
      (SELECT COUNT(*) FROM open_lines WHERE delai_client IS NOT NULL AND delai_client < ${backlogAsOf}::date)::int AS overdue_lines,
      (SELECT COALESCE(SUM(remaining_ht), 0) FROM open_lines WHERE delai_client IS NOT NULL AND delai_client < ${backlogAsOf}::date)::numeric(18,2)::text AS overdue_amount_ht,
      (SELECT COUNT(*) FROM open_lines WHERE delai_client IS NULL)::int AS undated_lines,
      (
        SELECT COALESCE(json_agg(x), '[]'::json) FROM (
          SELECT ol.commande_id::text AS commande_id, ol.numero, ol.client_id, c.company_name,
                 SUM(ol.remaining_ht)::numeric(18,2)::text AS remaining_ht,
                 MIN(ol.delai_client)::text AS earliest_due,
                 BOOL_OR(ol.delai_client IS NOT NULL AND ol.delai_client < ${backlogAsOf}::date) AS late
          FROM open_lines ol
          LEFT JOIN clients c ON c.client_id = ol.client_id
          GROUP BY ol.commande_id, ol.numero, ol.client_id, c.company_name
          ORDER BY SUM(ol.remaining_ht) DESC
          LIMIT ${backlogLimit}
        ) x
      ) AS top_backlog,
      (SELECT COUNT(DISTINCT commande_id) FROM open_lines)::int AS backlog_orders
  `;
  const backlogRes = await pool.query(backlogSql, bp.values);
  const backlogRow = backlogRes.rows[0] ?? {};
  const topBacklog = Array.isArray(backlogRow.top_backlog) ? backlogRow.top_backlog : [];

  // Reste à facturer : valeur expédiée qui n'a encore alimenté aucune ligne de facture.
  const ip = new Params();
  const invoiceScope = orderScope(ip, ctx, false);
  invoiceScope.push(`COALESCE(cc.order_type, 'FERME') <> 'INTERNE'`);
  invoiceScope.push(`bl.statut = ANY(${ip.push([...BL_SHIPPED_STATUSES])}::text[])`);
  invoiceScope.push(
    `COALESCE(bl.date_expedition, bl.date_livraison, bl.date_creation) <= ${ip.push(ctx.asOf)}::date`
  );
  const toInvoiceSql = `
    SELECT COALESCE(SUM(
      ${lineValueExpression("GREATEST(bll.quantite - COALESCE(inv.qty, 0), 0)")}
    ), 0)::numeric(18,2)::text AS to_invoice_ht
    FROM bon_livraison_ligne bll
    JOIN bon_livraison bl ON bl.id = bll.bon_livraison_id
    JOIN commande_ligne cl ON cl.id = bll.commande_ligne_id
    JOIN commande_client cc ON cc.id = cl.commande_id
    LEFT JOIN LATERAL (
      SELECT SUM(fsa.quantity_selected)::numeric(18,3) AS qty
      FROM facture_source_allocations fsa
      WHERE fsa.source_type = 'DELIVERY_LINE'
        AND fsa.source_line_id = bll.id::text
        AND fsa.allocation_status <> 'REVERSED'
    ) inv ON TRUE
    WHERE ${invoiceScope.join("\n      AND ")}
  `;
  const toInvoiceRes = await pool.query(toInvoiceSql, ip.values);

  const bookedCount = count(row.booked_count);
  const bookedAmount = money(row.booked_amount_ht);

  return {
    booked_count: bookedCount,
    booked_amount_ht: bookedAmount,
    internal_count: count(row.internal_count),
    internal_amount_ht: money(row.internal_amount_ht),
    average_order_ht: bookedCount > 0 ? bookedAmount / bookedCount : null,
    backlog_amount_ht: money(backlogRow.backlog_amount_ht),
    backlog_lines: count(backlogRow.backlog_lines),
    backlog_to_invoice_ht: money(toInvoiceRes.rows[0]?.to_invoice_ht),
    overdue_lines: count(backlogRow.overdue_lines),
    overdue_amount_ht: money(backlogRow.overdue_amount_ht),
    undated_lines: count(backlogRow.undated_lines),
    series: seriesRes.rows.map((r) => ({
      period: String(r.period),
      value: money(r.value),
      count: count(r.bucket_count),
    })),
    by_type: byTypeRes.rows.map((r) => ({
      order_type: String(r.order_type),
      count: count(r.count),
      amount_ht: money(r.amount_ht),
    })),
    top_backlog: topBacklog.map((r: Record<string, unknown>) => ({
      commande_id: Number.parseInt(String(r.commande_id), 10),
      numero: String(r.numero),
      client_id: String(r.client_id),
      company_name: (r.company_name as string | null) ?? null,
      remaining_ht: money(r.remaining_ht),
      earliest_due: (r.earliest_due as string | null) ?? null,
      late: Boolean(r.late),
    })),
    top_backlog_truncated: count(backlogRow.backlog_orders) > topBacklog.length,
  };
}

// ---------------------------------------------------------------------------
// Livraisons
// ---------------------------------------------------------------------------

export type DeliveriesSummary = {
  shipped_count: number;
  delivered_count: number;
  shipped_amount_ht: number;
  shipped_lines: number;
  on_time_lines: number;
  late_lines: number;
  undated_lines: number;
  unlinked_lines: number;
  on_time_rate: number | null;
  partial_orders: number;
  complete_orders: number;
  series: SeriesPoint[];
  top_late: Array<{
    bon_livraison_id: string;
    numero: string;
    client_id: string;
    company_name: string | null;
    date_expedition: string | null;
    delai_client: string | null;
    days_late: number;
  }>;
  top_late_truncated: boolean;
};

export async function repoDeliveries(ctx: ReportingContext): Promise<DeliveriesSummary> {
  const p = new Params();
  const shippedStatuses = p.push([...BL_SHIPPED_STATUSES]);
  const deliveredStatuses = p.push([...BL_DELIVERED_STATUSES]);
  const from = p.push(ctx.period.from);
  const to = p.push(ctx.period.to);
  const clientFilter = ctx.clientId ? `AND bl.client_id = ${p.push(ctx.clientId)}` : "";

  const headerSql = `
    SELECT
      COUNT(*) FILTER (
        WHERE bl.statut = ANY(${shippedStatuses}::text[])
          AND bl.date_expedition BETWEEN ${from}::date AND ${to}::date
      )::int AS shipped_count,
      COUNT(*) FILTER (
        WHERE bl.statut = ANY(${deliveredStatuses}::text[])
          AND bl.date_livraison BETWEEN ${from}::date AND ${to}::date
      )::int AS delivered_count,
      COUNT(*) FILTER (
        WHERE bl.statut = ANY(${shippedStatuses}::text[]) AND bl.date_expedition IS NULL
      )::int AS shipped_without_date
    FROM bon_livraison bl
    WHERE TRUE ${clientFilter}
  `;
  const headerRes = await pool.query(headerSql, p.values);
  const headerRow = headerRes.rows[0] ?? {};

  const lp = new Params();
  const lineStatuses = lp.push([...BL_SHIPPED_STATUSES]);
  const lFrom = lp.push(ctx.period.from);
  const lTo = lp.push(ctx.period.to);
  const lClient = ctx.clientId ? `AND bl.client_id = ${lp.push(ctx.clientId)}` : "";
  const lLimit = lp.push(ctx.limit);

  const linesSql = `
    WITH l AS (
      SELECT
        bl.id AS bon_livraison_id,
        bl.numero,
        bl.client_id,
        bl.date_expedition,
        bll.quantite::numeric(18,3) AS quantite,
        bll.commande_ligne_id,
        cl.delai_client,
        CASE
          WHEN cl.id IS NULL THEN NULL
          ELSE ${lineValueExpression("bll.quantite")}
        END AS value_ht
      FROM bon_livraison_ligne bll
      JOIN bon_livraison bl ON bl.id = bll.bon_livraison_id
      LEFT JOIN commande_ligne cl ON cl.id = bll.commande_ligne_id
      WHERE bl.statut = ANY(${lineStatuses}::text[])
        AND bl.date_expedition BETWEEN ${lFrom}::date AND ${lTo}::date
        ${lClient}
    )
    SELECT
      COUNT(*)::int AS shipped_lines,
      COALESCE(SUM(value_ht), 0)::numeric(18,2)::text AS shipped_amount_ht,
      COUNT(*) FILTER (WHERE commande_ligne_id IS NULL)::int AS unlinked_lines,
      COUNT(*) FILTER (WHERE delai_client IS NULL)::int AS undated_lines,
      COUNT(*) FILTER (WHERE delai_client IS NOT NULL AND date_expedition <= delai_client)::int AS on_time_lines,
      COUNT(*) FILTER (WHERE delai_client IS NOT NULL AND date_expedition > delai_client)::int AS late_lines,
      (
        SELECT COALESCE(json_agg(x), '[]'::json) FROM (
          SELECT l.bon_livraison_id::text AS bon_livraison_id, l.numero, l.client_id, c.company_name,
                 l.date_expedition::text AS date_expedition,
                 l.delai_client::text AS delai_client,
                 MAX(l.date_expedition - l.delai_client)::int AS days_late
          FROM l
          LEFT JOIN clients c ON c.client_id = l.client_id
          WHERE l.delai_client IS NOT NULL AND l.date_expedition > l.delai_client
          GROUP BY l.bon_livraison_id, l.numero, l.client_id, c.company_name, l.date_expedition, l.delai_client
          ORDER BY MAX(l.date_expedition - l.delai_client) DESC
          LIMIT ${lLimit}
        ) x
      ) AS top_late
    FROM l
  `;
  const linesRes = await pool.query(linesSql, lp.values);
  const linesRow = linesRes.rows[0] ?? {};
  const topLate = Array.isArray(linesRow.top_late) ? linesRow.top_late : [];

  const sp = new Params();
  const sStatuses = sp.push([...BL_SHIPPED_STATUSES]);
  const sFrom = sp.push(ctx.period.from);
  const sTo = sp.push(ctx.period.to);
  const sClient = ctx.clientId ? `AND bl.client_id = ${sp.push(ctx.clientId)}` : "";
  const bucket = truncExpression(ctx.granularity, "bl.date_expedition");
  const seriesRes = await pool.query(
    `SELECT (${bucket})::text AS period,
            COUNT(DISTINCT bl.id)::int AS bucket_count,
            COALESCE(SUM(CASE WHEN cl.id IS NULL THEN 0 ELSE ${lineValueExpression("bll.quantite")} END), 0)::numeric(18,2)::text AS value
     FROM bon_livraison bl
     JOIN bon_livraison_ligne bll ON bll.bon_livraison_id = bl.id
     LEFT JOIN commande_ligne cl ON cl.id = bll.commande_ligne_id
     WHERE bl.statut = ANY(${sStatuses}::text[])
       AND bl.date_expedition BETWEEN ${sFrom}::date AND ${sTo}::date
       ${sClient}
     GROUP BY (${bucket}) ORDER BY (${bucket}) ASC`,
    sp.values
  );

  // Commandes partiellement vs totalement livrées, à `as_of`.
  const cp = new Params();
  const cShipped = shippedLinesCte(cp, ctx.asOf);
  const cClient = ctx.clientId ? `AND cc.client_id = ${cp.push(ctx.clientId)}` : "";
  const completenessRes = await pool.query(
    `WITH ${cShipped},
     per_order AS (
       SELECT cc.id,
              SUM(GREATEST(cl.quantite - COALESCE(sl.quantite_expediee, 0), 0))::numeric(18,3) AS remaining,
              SUM(COALESCE(sl.quantite_expediee, 0))::numeric(18,3) AS shipped
       FROM commande_client cc
       JOIN commande_ligne cl ON cl.commande_id = cc.id
       LEFT JOIN shipped_lines sl ON sl.commande_ligne_id = cl.id
       WHERE COALESCE(cc.order_type, 'FERME') <> 'INTERNE' ${cClient}
       GROUP BY cc.id
     )
     SELECT
       COUNT(*) FILTER (WHERE shipped > 0 AND remaining > 0)::int AS partial_orders,
       COUNT(*) FILTER (WHERE shipped > 0 AND remaining = 0)::int AS complete_orders
     FROM per_order`,
    cp.values
  );
  const completenessRow = completenessRes.rows[0] ?? {};

  const onTime = count(linesRow.on_time_lines);
  const late = count(linesRow.late_lines);

  return {
    shipped_count: count(headerRow.shipped_count),
    delivered_count: count(headerRow.delivered_count),
    shipped_amount_ht: money(linesRow.shipped_amount_ht),
    shipped_lines: count(linesRow.shipped_lines),
    on_time_lines: onTime,
    late_lines: late,
    undated_lines: count(linesRow.undated_lines),
    unlinked_lines: count(linesRow.unlinked_lines),
    on_time_rate: ratio(onTime, onTime + late),
    partial_orders: count(completenessRow.partial_orders),
    complete_orders: count(completenessRow.complete_orders),
    series: seriesRes.rows.map((r) => ({
      period: String(r.period),
      value: money(r.value),
      count: count(r.bucket_count),
    })),
    top_late: topLate.map((r: Record<string, unknown>) => ({
      bon_livraison_id: String(r.bon_livraison_id),
      numero: String(r.numero),
      client_id: String(r.client_id),
      company_name: (r.company_name as string | null) ?? null,
      date_expedition: (r.date_expedition as string | null) ?? null,
      delai_client: (r.delai_client as string | null) ?? null,
      days_late: count(r.days_late),
    })),
    top_late_truncated: late > topLate.length,
  };
}

// ---------------------------------------------------------------------------
// Facturation
// ---------------------------------------------------------------------------

export type InvoicingSummary = {
  gross_ht: number;
  gross_ttc: number;
  credits_ht: number;
  credits_ttc: number;
  net_ht: number;
  net_ttc: number;
  tax_amount: number;
  invoice_count: number;
  credit_count: number;
  draft_count: number;
  cancelled_count: number;
  collected_ttc: number;
  collection_rate: number | null;
  series: SeriesPoint[];
};

export async function repoInvoicing(ctx: ReportingContext): Promise<InvoicingSummary> {
  const p = new Params();
  const ledgerF = ledgerFactureCte(p, {
    from: ctx.period.from,
    to: ctx.period.to,
    basis: ctx.basis,
    clientId: ctx.clientId,
    currency: ctx.currency,
  });
  const ledgerA = ledgerAvoirCte(p, {
    from: ctx.period.from,
    to: ctx.period.to,
    basis: ctx.basis,
    clientId: ctx.clientId,
    currency: ctx.currency,
  });

  const summarySql = `
    WITH ${ledgerF},
    ${ledgerA}
    SELECT
      (SELECT COALESCE(SUM(total_ht), 0)  FROM ledger_facture)::numeric(18,2)::text AS gross_ht,
      (SELECT COALESCE(SUM(total_ttc), 0) FROM ledger_facture)::numeric(18,2)::text AS gross_ttc,
      (SELECT COUNT(*) FROM ledger_facture)::int AS invoice_count,
      (SELECT COALESCE(SUM(total_ht), 0)  FROM ledger_avoir)::numeric(18,2)::text AS credits_ht,
      (SELECT COALESCE(SUM(total_ttc), 0) FROM ledger_avoir)::numeric(18,2)::text AS credits_ttc,
      (SELECT COUNT(*) FROM ledger_avoir)::int AS credit_count
  `;
  const summaryRes = await pool.query(summarySql, p.values);
  const row = summaryRes.rows[0] ?? {};

  // Pièces hors registre sur la même fenêtre : jamais additionnées, mais comptées.
  const xp = new Params();
  const xFrom = xp.push(ctx.period.from);
  const xTo = xp.push(ctx.period.to);
  const xClient = ctx.clientId ? `AND f.client_id = ${xp.push(ctx.clientId)}` : "";
  const outsideRes = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE f.statut = ANY(ARRAY['DRAFT','PENDING_VALIDATION','APPROVED','brouillon']))::int AS draft_count,
       COUNT(*) FILTER (WHERE f.statut = ANY(ARRAY['CANCELLED','annulee','annule']))::int AS cancelled_count
     FROM facture f
     WHERE f.date_emission BETWEEN ${xFrom}::date AND ${xTo}::date ${xClient}`,
    xp.values
  );
  const outsideRow = outsideRes.rows[0] ?? {};

  const sp = new Params();
  const sLedgerF = ledgerFactureCte(sp, {
    from: ctx.period.from,
    to: ctx.period.to,
    basis: ctx.basis,
    clientId: ctx.clientId,
    currency: ctx.currency,
  });
  const sLedgerA = ledgerAvoirCte(sp, {
    from: ctx.period.from,
    to: ctx.period.to,
    basis: ctx.basis,
    clientId: ctx.clientId,
    currency: ctx.currency,
  });
  const bucket = truncExpression(ctx.granularity, "u.ledger_date");
  const seriesRes = await pool.query(
    `WITH ${sLedgerF}, ${sLedgerA},
     u AS (
       SELECT ledger_date, total_ht, total_ttc, 1 AS doc FROM ledger_facture
       UNION ALL
       SELECT ledger_date, -total_ht, -total_ttc, 0 AS doc FROM ledger_avoir
     )
     SELECT (${bucket})::text AS period,
            COALESCE(SUM(u.total_ht), 0)::numeric(18,2)::text  AS value,
            COALESCE(SUM(u.total_ttc), 0)::numeric(18,2)::text AS secondary,
            COALESCE(SUM(u.doc), 0)::int AS bucket_count
     FROM u GROUP BY (${bucket}) ORDER BY (${bucket}) ASC`,
    sp.values
  );

  const cp = new Params();
  const cFrom = cp.push(ctx.period.from);
  const cTo = cp.push(ctx.period.to);
  const cNet = paiementNetPredicate(cp, "p");
  const cClient = ctx.clientId ? `AND p.client_id = ${cp.push(ctx.clientId)}` : "";
  const cCurrency = ctx.currency
    ? `AND UPPER(COALESCE(p.currency, 'EUR')) = ${cp.push(ctx.currency)}`
    : "";
  const collectedRes = await pool.query(
    `SELECT COALESCE(SUM(p.montant), 0)::numeric(18,2)::text AS collected_ttc
     FROM paiement p
     WHERE p.date_paiement BETWEEN ${cFrom}::date AND ${cTo}::date
       AND ${cNet} ${cClient} ${cCurrency}`,
    cp.values
  );

  const grossHt = money(row.gross_ht);
  const grossTtc = money(row.gross_ttc);
  const creditsHt = money(row.credits_ht);
  const creditsTtc = money(row.credits_ttc);
  const netHt = round2(grossHt - creditsHt);
  const netTtc = round2(grossTtc - creditsTtc);
  const collected = money(collectedRes.rows[0]?.collected_ttc);

  return {
    gross_ht: grossHt,
    gross_ttc: grossTtc,
    credits_ht: creditsHt,
    credits_ttc: creditsTtc,
    net_ht: netHt,
    net_ttc: netTtc,
    tax_amount: round2(netTtc - netHt),
    invoice_count: count(row.invoice_count),
    credit_count: count(row.credit_count),
    draft_count: count(outsideRow.draft_count),
    cancelled_count: count(outsideRow.cancelled_count),
    collected_ttc: collected,
    collection_rate: ratio(collected, netTtc),
    series: seriesRes.rows.map((r) => ({
      period: String(r.period),
      value: money(r.value),
      secondary: money(r.secondary),
      count: count(r.bucket_count),
    })),
  };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Encours
// ---------------------------------------------------------------------------

export type ReceivablesSummary = {
  as_of: string;
  open_ttc: number;
  open_count: number;
  overdue_ttc: number;
  overdue_count: number;
  credit_balance_ttc: number;
  credit_balance_count: number;
  unallocated_payments_ttc: number;
  unallocated_credits_ttc: number;
  aging: Array<{ key: string; label: string; amount_ttc: number; count: number }>;
  top_overdue: Array<{
    id: number;
    numero: string;
    client_id: string;
    company_name: string | null;
    date_emission: string;
    due_date: string | null;
    total_ttc: number;
    settled_ttc: number;
    credited_ttc: number;
    balance_ttc: number;
    days_overdue: number;
  }>;
  top_overdue_truncated: boolean;
};

export async function repoReceivables(ctx: ReportingContext): Promise<ReceivablesSummary> {
  const p = new Params();
  const ledger = ledgerFactureCte(p, {
    asOf: ctx.asOf,
    basis: ctx.basis,
    clientId: ctx.clientId,
    currency: ctx.currency,
  });
  const settled = settledCte(p, ctx.asOf);
  const credited = creditedCte(p, ctx.asOf, ctx.basis);
  const asOfParam = p.push(ctx.asOf);
  const limitParam = p.push(ctx.limit);
  const bucketExpr = agingBucketExpression(asOfParam);

  const sql = `
    WITH ${ledger},
    ${settled},
    ${credited},
    ${balancesCte()},
    open_balances AS (SELECT * FROM balances b WHERE b.balance_ttc > 0),
    aged AS (
      SELECT ${bucketExpr} AS bucket, b.balance_ttc
      FROM open_balances b
    )
    SELECT
      (SELECT COALESCE(SUM(balance_ttc), 0) FROM open_balances)::numeric(18,2)::text AS open_ttc,
      (SELECT COUNT(*) FROM open_balances)::int AS open_count,
      (SELECT COALESCE(SUM(balance_ttc), 0) FROM open_balances b WHERE b.due_date < ${asOfParam}::date)::numeric(18,2)::text AS overdue_ttc,
      (SELECT COUNT(*) FROM open_balances b WHERE b.due_date < ${asOfParam}::date)::int AS overdue_count,
      (SELECT COALESCE(SUM(-balance_ttc), 0) FROM balances b WHERE b.balance_ttc < 0)::numeric(18,2)::text AS credit_balance_ttc,
      (SELECT COUNT(*) FROM balances b WHERE b.balance_ttc < 0)::int AS credit_balance_count,
      (
        SELECT COALESCE(json_agg(x), '[]'::json) FROM (
          SELECT bucket, COALESCE(SUM(balance_ttc), 0)::numeric(18,2)::text AS amount_ttc, COUNT(*)::int AS count
          FROM aged GROUP BY bucket
        ) x
      ) AS aging,
      (
        SELECT COALESCE(json_agg(y), '[]'::json) FROM (
          SELECT b.id::text AS id, b.numero, b.client_id, c.company_name,
                 b.date_emission::text AS date_emission,
                 b.due_date::text AS due_date,
                 b.total_ttc::text AS total_ttc,
                 b.settled_ttc::text AS settled_ttc,
                 b.credited_ttc::text AS credited_ttc,
                 b.balance_ttc::text AS balance_ttc,
                 GREATEST(${asOfParam}::date - b.due_date, 0)::int AS days_overdue
          FROM open_balances b
          LEFT JOIN clients c ON c.client_id = b.client_id
          WHERE b.due_date < ${asOfParam}::date
          ORDER BY b.balance_ttc DESC, b.id DESC
          LIMIT ${limitParam}
        ) y
      ) AS top_overdue
  `;

  const res = await pool.query(sql, p.values);
  const row = res.rows[0] ?? {};
  const agingRaw: Array<Record<string, unknown>> = Array.isArray(row.aging) ? row.aging : [];
  const agingMap = new Map(agingRaw.map((r) => [String(r.bucket), r]));
  const topOverdue = Array.isArray(row.top_overdue) ? row.top_overdue : [];

  const unallocated = await repoUnallocated(ctx);

  return {
    as_of: ctx.asOf,
    open_ttc: money(row.open_ttc),
    open_count: count(row.open_count),
    overdue_ttc: money(row.overdue_ttc),
    overdue_count: count(row.overdue_count),
    credit_balance_ttc: money(row.credit_balance_ttc),
    credit_balance_count: count(row.credit_balance_count),
    unallocated_payments_ttc: unallocated.payments_ttc,
    unallocated_credits_ttc: unallocated.credits_ttc,
    // Les cinq tranches sont toujours présentes, y compris à zéro : une tranche
    // absente serait lue comme une donnée manquante.
    aging: AGING_BUCKETS.map((bucket) => {
      const found = agingMap.get(bucket.key);
      return {
        key: bucket.key,
        label: bucket.label,
        amount_ttc: money(found?.amount_ttc),
        count: count(found?.count),
      };
    }),
    top_overdue: topOverdue.map((r: Record<string, unknown>) => ({
      id: Number.parseInt(String(r.id), 10),
      numero: String(r.numero),
      client_id: String(r.client_id),
      company_name: (r.company_name as string | null) ?? null,
      date_emission: String(r.date_emission),
      due_date: (r.due_date as string | null) ?? null,
      total_ttc: money(r.total_ttc),
      settled_ttc: money(r.settled_ttc),
      credited_ttc: money(r.credited_ttc),
      balance_ttc: money(r.balance_ttc),
      days_overdue: count(r.days_overdue),
    })),
    top_overdue_truncated: count(row.overdue_count) > topOverdue.length,
  };
}

async function repoUnallocated(
  ctx: ReportingContext
): Promise<{ payments_ttc: number; credits_ttc: number }> {
  const p = new Params();
  const asOf = p.push(ctx.asOf);
  const net = paiementNetPredicate(p, "p");
  const avoirStatuses = p.push([...AVOIR_LEDGER_STATUSES]);
  const clientPay = ctx.clientId ? `AND p.client_id = ${p.push(ctx.clientId)}` : "";
  const clientCred = ctx.clientId ? `AND a.client_id = ${p.push(ctx.clientId)}` : "";

  const res = await pool.query(
    `WITH pay AS (
       SELECT ${paiementAvailableAmountExpression("p", {
         allocationAsOfDateSql: `${asOf}::date`,
       })}::numeric(18,2) AS available
       FROM paiement p
       WHERE p.date_paiement <= ${asOf}::date AND ${net} ${clientPay}
     ),
     cred AS (
       SELECT a.total_ttc::numeric(18,2) AS montant,
              COALESCE((
                SELECT SUM(asa.amount_ttc) FROM avoir_source_allocations asa
                WHERE asa.avoir_id = a.id AND asa.allocation_status <> 'REVERSED'
                  AND (asa.created_at AT TIME ZONE 'Europe/Paris')::date <= ${asOf}::date
              ), 0)::numeric(18,2) AS allocated
       FROM avoir a
       WHERE a.statut = ANY(${avoirStatuses}::text[])
         AND a.date_emission <= ${asOf}::date
         AND a.facture_id IS NULL ${clientCred}
     )
     SELECT
       COALESCE((SELECT SUM(available) FROM pay), 0)::numeric(18,2)::text AS payments_ttc,
       COALESCE((SELECT SUM(GREATEST(montant - allocated, 0)) FROM cred), 0)::numeric(18,2)::text AS credits_ttc`,
    p.values
  );
  const row = res.rows[0] ?? {};
  return { payments_ttc: money(row.payments_ttc), credits_ttc: money(row.credits_ttc) };
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export type ClientsSummary = {
  client_count: number;
  net_ht_total: number;
  top5_share: number | null;
  top10_share: number | null;
  new_clients: number;
  recurring_clients: number;
  dormant_clients: number;
  items: Array<{
    client_id: string;
    company_name: string | null;
    net_ht: number;
    net_ttc: number;
    invoice_count: number;
    credit_count: number;
    share: number | null;
    open_ttc: number;
    overdue_ttc: number;
  }>;
  truncated: boolean;
};

export async function repoClients(ctx: ReportingContext): Promise<ClientsSummary> {
  const p = new Params();
  const ledgerF = ledgerFactureCte(p, {
    from: ctx.period.from,
    to: ctx.period.to,
    basis: ctx.basis,
    clientId: ctx.clientId,
    currency: ctx.currency,
  });
  const ledgerA = ledgerAvoirCte(p, {
    from: ctx.period.from,
    to: ctx.period.to,
    basis: ctx.basis,
    clientId: ctx.clientId,
    currency: ctx.currency,
  });
  const receivablesLedger = ledgerFactureCte(p, {
    asOf: ctx.asOf,
    basis: ctx.basis,
    clientId: ctx.clientId,
    currency: ctx.currency,
  }).replace("ledger_facture AS", "ledger_open AS");
  const settled = settledCte(p, ctx.asOf);
  const credited = creditedCte(p, ctx.asOf, ctx.basis);
  const asOfParam = p.push(ctx.asOf);
  const limitParam = p.push(ctx.limit);

  const sql = `
    WITH ${ledgerF},
    ${ledgerA},
    ${receivablesLedger},
    ${settled},
    ${credited},
    open_balances AS (
      SELECT lo.client_id,
             (lo.total_ttc - COALESCE(s.amount, 0) - COALESCE(c.amount, 0))::numeric(18,2) AS balance_ttc,
             lo.due_date
      FROM ledger_open lo
      LEFT JOIN settled  s ON s.facture_id = lo.id
      LEFT JOIN credited c ON c.facture_id = lo.id
    ),
    per_client AS (
      SELECT client_id,
             SUM(net_ht)::numeric(18,2) AS net_ht,
             SUM(net_ttc)::numeric(18,2) AS net_ttc,
             SUM(invoice_count)::int AS invoice_count,
             SUM(credit_count)::int AS credit_count
      FROM (
        SELECT client_id, total_ht AS net_ht, total_ttc AS net_ttc, 1 AS invoice_count, 0 AS credit_count FROM ledger_facture
        UNION ALL
        SELECT client_id, -total_ht, -total_ttc, 0, 1 FROM ledger_avoir
      ) u
      GROUP BY client_id
    ),
    ranked AS (
      SELECT pc.*, ROW_NUMBER() OVER (ORDER BY pc.net_ht DESC, pc.client_id ASC) AS rn
      FROM per_client pc
    )
    SELECT
      (SELECT COUNT(*) FROM per_client)::int AS client_count,
      (SELECT COALESCE(SUM(net_ht), 0) FROM per_client)::numeric(18,2)::text AS net_ht_total,
      (SELECT COALESCE(SUM(net_ht), 0) FROM ranked WHERE rn <= 5)::numeric(18,2)::text  AS top5_ht,
      (SELECT COALESCE(SUM(net_ht), 0) FROM ranked WHERE rn <= 10)::numeric(18,2)::text AS top10_ht,
      (
        SELECT COALESCE(json_agg(x ORDER BY x.rn), '[]'::json) FROM (
          SELECT r.rn, r.client_id, c.company_name,
                 r.net_ht::text  AS net_ht,
                 r.net_ttc::text AS net_ttc,
                 r.invoice_count, r.credit_count,
                 COALESCE((SELECT SUM(ob.balance_ttc) FROM open_balances ob
                           WHERE ob.client_id = r.client_id AND ob.balance_ttc > 0), 0)::numeric(18,2)::text AS open_ttc,
                 COALESCE((SELECT SUM(ob.balance_ttc) FROM open_balances ob
                           WHERE ob.client_id = r.client_id AND ob.balance_ttc > 0
                             AND ob.due_date < ${asOfParam}::date), 0)::numeric(18,2)::text AS overdue_ttc
          FROM ranked r
          LEFT JOIN clients c ON c.client_id = r.client_id
          WHERE r.rn <= ${limitParam}
        ) x
      ) AS items
  `;
  const res = await pool.query(sql, p.values);
  const row = res.rows[0] ?? {};
  const items: Array<Record<string, unknown>> = Array.isArray(row.items) ? row.items : [];
  const total = money(row.net_ht_total);

  const cohort = await repoClientCohorts(ctx);

  return {
    client_count: count(row.client_count),
    net_ht_total: total,
    top5_share: ratio(money(row.top5_ht), total),
    top10_share: ratio(money(row.top10_ht), total),
    new_clients: cohort.new_clients,
    recurring_clients: cohort.recurring_clients,
    dormant_clients: cohort.dormant_clients,
    items: items.map((r) => {
      const netHt = money(r.net_ht);
      return {
        client_id: String(r.client_id),
        company_name: (r.company_name as string | null) ?? null,
        net_ht: netHt,
        net_ttc: money(r.net_ttc),
        invoice_count: count(r.invoice_count),
        credit_count: count(r.credit_count),
        share: ratio(netHt, total),
        open_ttc: money(r.open_ttc),
        overdue_ttc: money(r.overdue_ttc),
      };
    }),
    truncated: count(row.client_count) > items.length,
  };
}

/**
 * Cohortes clients de la période :
 *  - nouveau  : premier document du registre pendant la période ;
 *  - récurrent: facturé pendant la période ET avant ;
 *  - dormant  : facturé avant, rien pendant la période, et pas de commande en cours.
 */
async function repoClientCohorts(
  ctx: ReportingContext
): Promise<{ new_clients: number; recurring_clients: number; dormant_clients: number }> {
  const p = new Params();
  const statuses = p.push([...FACTURE_LEDGER_STATUSES]);
  const from = p.push(ctx.period.from);
  const to = p.push(ctx.period.to);

  const res = await pool.query(
    `WITH billed AS (
       SELECT f.client_id, MIN(f.date_emission) AS first_date, MAX(f.date_emission) AS last_date
       FROM facture f
       WHERE f.statut = ANY(${statuses}::text[])
       GROUP BY f.client_id
     ),
     in_period AS (
       SELECT DISTINCT f.client_id
       FROM facture f
       WHERE f.statut = ANY(${statuses}::text[])
         AND f.date_emission BETWEEN ${from}::date AND ${to}::date
     )
     SELECT
       COUNT(*) FILTER (WHERE b.first_date BETWEEN ${from}::date AND ${to}::date)::int AS new_clients,
       COUNT(*) FILTER (
         WHERE b.first_date < ${from}::date AND b.client_id IN (SELECT client_id FROM in_period)
       )::int AS recurring_clients,
       COUNT(*) FILTER (
         WHERE b.last_date < ${from}::date AND b.client_id NOT IN (SELECT client_id FROM in_period)
       )::int AS dormant_clients
     FROM billed b`,
    p.values
  );
  const row = res.rows[0] ?? {};
  return {
    new_clients: count(row.new_clients),
    recurring_clients: count(row.recurring_clients),
    dormant_clients: count(row.dormant_clients),
  };
}

// ---------------------------------------------------------------------------
// Devises et qualité de données
// ---------------------------------------------------------------------------

export async function repoCurrencies(ctx: ReportingContext): Promise<string[]> {
  const p = new Params();
  const statuses = p.push([...FACTURE_LEDGER_STATUSES]);
  const avoirStatuses = p.push([...AVOIR_LEDGER_STATUSES]);
  const from = p.push(ctx.period.from);
  const to = p.push(ctx.period.to);
  const res = await pool.query(
    `SELECT DISTINCT currency FROM (
       SELECT UPPER(COALESCE(f.currency, 'EUR')) AS currency FROM facture f
       WHERE f.statut = ANY(${statuses}::text[]) AND f.date_emission BETWEEN ${from}::date AND ${to}::date
       UNION
       SELECT UPPER(COALESCE(a.currency, 'EUR')) FROM avoir a
       WHERE a.statut = ANY(${avoirStatuses}::text[]) AND a.date_emission BETWEEN ${from}::date AND ${to}::date
       UNION
       SELECT UPPER(COALESCE(p2.currency, 'EUR')) FROM paiement p2
       WHERE p2.date_paiement BETWEEN ${from}::date AND ${to}::date
     ) u
     WHERE currency IS NOT NULL
     ORDER BY 1`,
    p.values
  );
  return res.rows.map((r) => String(r.currency));
}

export async function repoDataQuality(ctx: ReportingContext): Promise<Anomaly[]> {
  const p = new Params();
  const from = p.push(ctx.period.from);
  const to = p.push(ctx.period.to);
  const asOf = p.push(ctx.asOf);
  const ledgerStatuses = p.push([...FACTURE_LEDGER_STATUSES]);
  const shippedStatuses = p.push([...BL_SHIPPED_STATUSES]);
  const knownFacture = p.push([
    ...FACTURE_LEDGER_STATUSES,
    "DRAFT",
    "PENDING_VALIDATION",
    "APPROVED",
    "CANCELLED",
    "brouillon",
    "annulee",
    "annule",
  ]);

  const res = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM facture f
        WHERE f.statut = ANY(${ledgerStatuses}::text[])
          AND f.date_emission BETWEEN ${from}::date AND ${to}::date
          AND f.date_echeance IS NULL)::int AS invoices_without_due_date,
       (SELECT COUNT(*) FROM facture f
        WHERE NOT (f.statut = ANY(${knownFacture}::text[])))::int AS invoices_unknown_status,
       (SELECT COUNT(*) FROM bon_livraison bl
        WHERE bl.statut = ANY(${shippedStatuses}::text[]) AND bl.date_expedition IS NULL)::int AS deliveries_without_ship_date,
       (SELECT COUNT(*) FROM bon_livraison_ligne bll
        JOIN bon_livraison bl ON bl.id = bll.bon_livraison_id
        WHERE bl.statut = ANY(${shippedStatuses}::text[])
          AND bl.date_expedition BETWEEN ${from}::date AND ${to}::date
          AND bll.commande_ligne_id IS NULL)::int AS delivery_lines_unlinked,
       (SELECT COUNT(*) FROM commande_client cc
        WHERE cc.date_commande BETWEEN ${from}::date AND ${to}::date
          AND NOT EXISTS (SELECT 1 FROM commande_ligne cl WHERE cl.commande_id = cc.id))::int AS orders_without_lines,
       (SELECT COUNT(*) FROM devis d
        WHERE d.statut = 'ENVOYE' AND d.date_validite IS NOT NULL AND d.date_validite < ${asOf}::date)::int AS quotes_expired_not_requalified,
       (SELECT COUNT(*) FROM paiement p
        WHERE p.date_paiement BETWEEN ${from}::date AND ${to}::date
          AND p.facture_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM paiement_allocations pa WHERE pa.paiement_id = p.id))::int AS payments_unallocated`,
    p.values
  );
  const row = res.rows[0] ?? {};

  const anomalies: Anomaly[] = [
    {
      code: "invoices_without_due_date",
      label: "Factures sans échéance",
      count: count(row.invoices_without_due_date),
      severity: "warning",
      hint: "L'échéance retombe sur la date d'émission : la balance âgée les vieillit trop vite.",
    },
    {
      code: "invoices_unknown_status",
      label: "Factures au statut hors vocabulaire",
      count: count(row.invoices_unknown_status),
      severity: "warning",
      hint: "Ces pièces n'entrent dans aucun agrégat. À requalifier manuellement.",
    },
    {
      code: "deliveries_without_ship_date",
      label: "BL expédiés sans date d'expédition",
      count: count(row.deliveries_without_ship_date),
      severity: "warning",
      hint: "Exclus de toute période : ils faussent les volumes livrés à la baisse.",
    },
    {
      code: "delivery_lines_unlinked",
      label: "Lignes de BL sans ligne de commande",
      count: count(row.delivery_lines_unlinked),
      severity: "info",
      hint: "Comptées en quantité mais non valorisables : aucun prix de référence.",
    },
    {
      code: "orders_without_lines",
      label: "Commandes sans ligne",
      count: count(row.orders_without_lines),
      severity: "info",
      hint: "Pèsent zéro dans le carnet de commandes.",
    },
    {
      code: "quotes_expired_not_requalified",
      label: "Devis périmés non requalifiés",
      count: count(row.quotes_expired_not_requalified),
      severity: "info",
      hint: "Encore comptés dans le portefeuille ouvert alors que leur validité est dépassée.",
    },
    {
      code: "payments_unallocated",
      label: "Règlements non affectés",
      count: count(row.payments_unallocated),
      severity: "info",
      hint: "Encaissés mais rattachés à aucune facture : ils ne réduisent aucun encours.",
    },
  ];

  return anomalies.filter((anomaly) => anomaly.count > 0);
}

// ---------------------------------------------------------------------------
// Drill-down
// ---------------------------------------------------------------------------

export type DrilldownRow = Record<string, string | number | boolean | null>;

export type DrilldownResult = {
  entity: string;
  scope: string;
  rows: DrilldownRow[];
  total: number;
  truncated: boolean;
};

export async function repoDrilldown(
  ctx: ReportingContext,
  entity: string,
  scope: string
): Promise<DrilldownResult> {
  switch (entity) {
    case "quotes":
      return drilldownQuotes(ctx, scope);
    case "orders":
      return drilldownOrders(ctx, scope);
    case "order_lines":
      return drilldownOrderLines(ctx, scope);
    case "deliveries":
      return drilldownDeliveries(ctx, scope);
    case "invoices":
      return drilldownInvoices(ctx, scope);
    case "credit_notes":
      return drilldownCreditNotes(ctx);
    case "payments":
      return drilldownPayments(ctx, scope);
    case "clients": {
      const clients = await repoClients(ctx);
      return {
        entity,
        scope,
        rows: clients.items as unknown as DrilldownRow[],
        total: clients.client_count,
        truncated: clients.truncated,
      };
    }
    default:
      return { entity, scope, rows: [], total: 0, truncated: false };
  }
}

async function drilldownQuotes(ctx: ReportingContext, scope: string): Promise<DrilldownResult> {
  const p = new Params();
  const where = quoteScope(p, ctx, scope !== "open");
  if (scope === "open") where.push(`d.statut = 'ENVOYE'`);
  if (scope === "won") where.push(`d.statut = 'ACCEPTE'`);
  if (scope === "lost") where.push(`d.statut = 'REFUSE'`);
  if (scope === "expired") where.push(`d.statut = 'EXPIRE'`);
  if (scope === "decided") where.push(`d.statut = ANY(${p.push([...DEVIS_DECIDED_STATUSES])}::text[])`);
  const limit = p.push(ctx.limit);

  const res = await pool.query(
    `SELECT d.id::text AS id, d.numero, d.client_id, c.company_name, d.statut,
            d.total_ht::numeric(18,2)::text AS total_ht,
            d.date_creation::date::text AS date_creation,
            d.date_validite::text AS date_validite,
            COUNT(*) OVER ()::int AS total_rows
     FROM devis d
     LEFT JOIN clients c ON c.client_id = d.client_id
     WHERE ${where.join(" AND ")}
     ORDER BY d.total_ht DESC, d.id DESC
     LIMIT ${limit}`,
    p.values
  );
  return buildDrilldown("quotes", scope, res.rows, ["total_ht"]);
}

async function drilldownOrders(ctx: ReportingContext, scope: string): Promise<DrilldownResult> {
  const p = new Params();
  const where = orderScope(p, ctx, true);
  const limit = p.push(ctx.limit);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const res = await pool.query(
    `SELECT cc.id::text AS id, cc.numero, cc.client_id, c.company_name,
            COALESCE(cc.order_type, 'FERME') AS order_type,
            cc.date_commande::text AS date_commande,
            cc.total_ht::numeric(18,2)::text AS total_ht,
            COUNT(*) OVER ()::int AS total_rows
     FROM commande_client cc
     LEFT JOIN clients c ON c.client_id = cc.client_id
     ${whereSql}
     ORDER BY cc.total_ht DESC, cc.id DESC
     LIMIT ${limit}`,
    p.values
  );
  return buildDrilldown("orders", scope, res.rows, ["total_ht"]);
}

async function drilldownOrderLines(ctx: ReportingContext, scope: string): Promise<DrilldownResult> {
  const p = new Params();
  const shipped = shippedLinesCte(p, ctx.asOf);
  const where = orderScope(p, ctx, false);
  where.push(`COALESCE(cc.order_type, 'FERME') <> 'INTERNE'`);
  const asOf = p.push(ctx.asOf);
  const limit = p.push(ctx.limit);
  const remaining = `GREATEST(cl.quantite - COALESCE(sl.quantite_expediee, 0), 0)`;
  const lateFilter = scope === "late" ? `AND cl.delai_client IS NOT NULL AND cl.delai_client < ${asOf}::date` : "";

  const res = await pool.query(
    `WITH ${shipped}
     SELECT cl.id::text AS id, cc.id::text AS commande_id, cc.numero, cc.client_id, c.company_name,
            cl.designation, cl.code_piece,
            cl.quantite::numeric(18,3)::text AS quantite_commandee,
            ${remaining}::numeric(18,3)::text AS quantite_restante,
            ${lineValueExpression(remaining)}::text AS remaining_ht,
            cl.delai_client::text AS delai_client,
            (cl.delai_client IS NOT NULL AND cl.delai_client < ${asOf}::date) AS late,
            COUNT(*) OVER ()::int AS total_rows
     FROM commande_ligne cl
     JOIN commande_client cc ON cc.id = cl.commande_id
     LEFT JOIN clients c ON c.client_id = cc.client_id
     LEFT JOIN shipped_lines sl ON sl.commande_ligne_id = cl.id
     WHERE ${where.join(" AND ")}
       AND ${remaining} > 0 ${lateFilter}
     ORDER BY ${lineValueExpression(remaining)} DESC, cl.id DESC
     LIMIT ${limit}`,
    p.values
  );
  return buildDrilldown("order_lines", scope, res.rows, ["remaining_ht"]);
}

async function drilldownDeliveries(ctx: ReportingContext, scope: string): Promise<DrilldownResult> {
  const p = new Params();
  const statuses = p.push(scope === "delivered" ? [...BL_DELIVERED_STATUSES] : [...BL_SHIPPED_STATUSES]);
  const from = p.push(ctx.period.from);
  const to = p.push(ctx.period.to);
  const clientFilter = ctx.clientId ? `AND bl.client_id = ${p.push(ctx.clientId)}` : "";
  const limit = p.push(ctx.limit);
  const dateColumn = scope === "delivered" ? "bl.date_livraison" : "bl.date_expedition";

  const res = await pool.query(
    `SELECT bl.id::text AS id, bl.numero, bl.client_id, c.company_name, bl.statut,
            bl.date_expedition::text AS date_expedition,
            bl.date_livraison::text AS date_livraison,
            COUNT(*) OVER ()::int AS total_rows
     FROM bon_livraison bl
     LEFT JOIN clients c ON c.client_id = bl.client_id
     WHERE bl.statut = ANY(${statuses}::text[])
       AND ${dateColumn} BETWEEN ${from}::date AND ${to}::date
       ${clientFilter}
     ORDER BY ${dateColumn} DESC, bl.numero DESC
     LIMIT ${limit}`,
    p.values
  );
  return buildDrilldown("deliveries", scope, res.rows, []);
}

async function drilldownInvoices(ctx: ReportingContext, scope: string): Promise<DrilldownResult> {
  const p = new Params();
  const useAsOf = scope === "outstanding" || scope === "overdue" || scope === "credit_balance";
  const ledger = ledgerFactureCte(p, {
    ...(useAsOf ? { asOf: ctx.asOf } : { from: ctx.period.from, to: ctx.period.to }),
    basis: ctx.basis,
    clientId: ctx.clientId,
    currency: ctx.currency,
  });
  const settled = settledCte(p, ctx.asOf);
  const credited = creditedCte(p, ctx.asOf, ctx.basis);
  const asOf = p.push(ctx.asOf);
  const limit = p.push(ctx.limit);

  const balanceFilter =
    scope === "overdue"
      ? `WHERE b.balance_ttc > 0 AND b.due_date < ${asOf}::date`
      : scope === "outstanding"
        ? `WHERE b.balance_ttc > 0`
        : scope === "credit_balance"
          ? `WHERE b.balance_ttc < 0`
          : "";

  const res = await pool.query(
    `WITH ${ledger}, ${settled}, ${credited}, ${balancesCte()}
     SELECT b.id::text AS id, b.numero, b.client_id, c.company_name, b.statut,
            b.date_emission::text AS date_emission,
            b.due_date::text AS due_date,
            b.total_ht::text AS total_ht,
            b.total_ttc::text AS total_ttc,
            b.settled_ttc::text AS settled_ttc,
            b.credited_ttc::text AS credited_ttc,
            b.balance_ttc::text AS balance_ttc,
            b.currency,
            COUNT(*) OVER ()::int AS total_rows
     FROM balances b
     LEFT JOIN clients c ON c.client_id = b.client_id
     ${balanceFilter}
     ORDER BY b.balance_ttc DESC, b.id DESC
     LIMIT ${limit}`,
    p.values
  );
  return buildDrilldown("invoices", scope, res.rows, [
    "total_ht",
    "total_ttc",
    "settled_ttc",
    "credited_ttc",
    "balance_ttc",
  ]);
}

async function drilldownCreditNotes(ctx: ReportingContext): Promise<DrilldownResult> {
  const p = new Params();
  const ledger = ledgerAvoirCte(p, {
    from: ctx.period.from,
    to: ctx.period.to,
    basis: ctx.basis,
    clientId: ctx.clientId,
    currency: ctx.currency,
  });
  const limit = p.push(ctx.limit);
  const res = await pool.query(
    `WITH ${ledger}
     SELECT la.id::text AS id, la.numero, la.client_id, c.company_name, la.statut,
            la.facture_id::text AS facture_id,
            la.date_emission::text AS date_emission,
            la.total_ht::text AS total_ht,
            la.total_ttc::text AS total_ttc,
            la.currency,
            COUNT(*) OVER ()::int AS total_rows
     FROM ledger_avoir la
     LEFT JOIN clients c ON c.client_id = la.client_id
     ORDER BY la.total_ttc DESC, la.id DESC
     LIMIT ${limit}`,
    p.values
  );
  return buildDrilldown("credit_notes", "all", res.rows, ["total_ht", "total_ttc"]);
}

async function drilldownPayments(ctx: ReportingContext, scope: string): Promise<DrilldownResult> {
  const p = new Params();
  const net = paiementNetPredicate(p, "p");
  const from = p.push(ctx.period.from);
  const to = p.push(ctx.period.to);
  const asOf = p.push(ctx.asOf);
  const clientFilter = ctx.clientId ? `AND p.client_id = ${p.push(ctx.clientId)}` : "";
  const limit = p.push(ctx.limit);
  const allocationOptions = { allocationAsOfDateSql: `${asOf}::date` };
  const unallocatedFilter = scope === "unallocated" ? "WHERE pr.available_amount > 0::numeric" : "";

  const res = await pool.query(
    `WITH payment_read AS (
       SELECT p.*,
              ${paiementAllocatedAmountExpression("p", allocationOptions)}::numeric(18,2) AS allocated_amount,
              ${paiementAvailableAmountExpression("p", allocationOptions)}::numeric(18,2) AS available_amount,
              ${paiementProjectedStatusExpression("p")} AS projected_status
       FROM paiement p
       WHERE p.date_paiement BETWEEN ${from}::date AND ${to}::date
         AND ${net} ${clientFilter}
     )
     SELECT pr.id::text AS id, pr.code, pr.client_id, c.company_name,
            pr.date_paiement::text AS date_paiement,
            pr.montant::numeric(18,2)::text AS montant,
            pr.allocated_amount::text AS allocated_amount,
            pr.available_amount::text AS available_amount,
            pr.mode, pr.projected_status AS status, pr.workflow_status, pr.currency,
            pr.facture_id::text AS facture_id,
            COUNT(*) OVER ()::int AS total_rows
     FROM payment_read pr
     LEFT JOIN clients c ON c.client_id = pr.client_id
     ${unallocatedFilter}
     ORDER BY pr.date_paiement DESC, pr.id DESC
     LIMIT ${limit}`,
    p.values
  );
  return buildDrilldown("payments", scope, res.rows, ["montant", "allocated_amount", "available_amount"]);
}

function buildDrilldown(
  entity: string,
  scope: string,
  rows: Array<Record<string, unknown>>,
  moneyFields: string[]
): DrilldownResult {
  const total = rows.length > 0 ? count(rows[0].total_rows) : 0;
  const mapped: DrilldownRow[] = rows.map((row) => {
    const out: DrilldownRow = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === "total_rows") continue;
      if (moneyFields.includes(key)) {
        out[key] = money(value);
      } else if (value === null || value === undefined) {
        out[key] = null;
      } else if (typeof value === "boolean" || typeof value === "number") {
        out[key] = value;
      } else {
        out[key] = String(value);
      }
    }
    return out;
  });
  return { entity, scope, rows: mapped, total, truncated: total > mapped.length };
}
