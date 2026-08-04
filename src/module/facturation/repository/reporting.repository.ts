// Reporting commercial — endpoints historiques (#227), corrigés par #275.
//
// Le contrat de sortie est INCHANGÉ (les consommateurs `facture-command-center` et
// `ReportingCommercialPage` continuent de fonctionner) ; seuls des champs sont ajoutés.
// Ce qui change, c'est la justesse :
//
//  1. `outstanding` reconstruit réellement l'état à `as_of`. Avant, les règlements et
//     les avoirs postérieurs à la date d'arrêté entraient dans le calcul : un virement
//     encaissé demain modifiait l'encours d'hier.
//  2. Le périmètre de statuts n'est plus `<> 'brouillon'` — filtre qui laissait entrer
//     `DRAFT`, `PENDING_VALIDATION`, `APPROVED` et surtout `CANCELLED` dans l'encours.
//     Il repose désormais sur le vocabulaire réel (canonique #227 + héritage minuscule).
//  3. `GREATEST(0, …)` ne masque plus les trop-perçus : les soldes créditeurs sont
//     isolés et exposés.
//  4. Les sommes sont faites en NUMERIC, plus en float8.
//
// `include_brouillon` est conservé pour compatibilité de signature : il élargit le
// périmètre aux pièces en préparation. Il n'a jamais eu, et n'a toujours pas, vocation
// à faire entrer une pièce annulée dans un agrégat.

import pool from "../../../config/database";
import {
  AVOIR_LEDGER_STATUSES,
  DEFAULT_CURRENCY,
  FACTURE_DRAFT_STATUSES,
  FACTURE_LEDGER_STATUSES,
  todayInParis,
} from "../domain/reporting-policy";
import {
  Params,
  balancesCte,
  count,
  creditedCte,
  ledgerFactureCte,
  money,
  paiementAvailableAmountExpression,
  paiementNetPredicate,
  settledCte,
} from "./reporting-sql";
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
  /** #275 — champs additifs, ignorés par les consommateurs historiques. */
  credit_balance_ttc: number;
  count_credit_balance: number;
  unallocated_payments_ttc: number;
  unallocated_credits_ttc: number;
  truncated: boolean;
  metric_ids: string[];
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

function granularityExpr(granularity: RevenueQueryDTO["granularity"], column: string): string {
  switch (granularity) {
    case "week":
      return `date_trunc('week', ${column})::date`;
    case "year":
      return `date_trunc('year', ${column})::date`;
    case "month":
    default:
      return `date_trunc('month', ${column})::date`;
  }
}

/** Périmètre de statuts de facture retenu pour un agrégat de flux. */
function factureStatuses(includeDraft: boolean): string[] {
  return includeDraft
    ? [...FACTURE_LEDGER_STATUSES, ...FACTURE_DRAFT_STATUSES]
    : [...FACTURE_LEDGER_STATUSES];
}

/**
 * `Facturé net` par période — factures du registre moins avoirs finalisés, sur la date
 * d'émission portée par la pièce.
 *
 * Ce n'est PAS un chiffre d'affaires comptable : aucune règle de rattachement à
 * l'exercice n'a été validée. Le libellé côté interface est « Facturé net ».
 */
export async function repoCommercialRevenue(query: RevenueQueryDTO): Promise<{ buckets: RevenueBucket[] }> {
  const p = new Params();
  const factureWhere: string[] = [
    `f.statut = ANY(${p.push(factureStatuses(query.include_brouillon))}::text[])`,
  ];
  const avoirWhere: string[] = [`a.statut = ANY(${p.push([...AVOIR_LEDGER_STATUSES])}::text[])`];

  if (query.from) {
    const bound = p.push(query.from);
    factureWhere.push(`f.date_emission >= ${bound}::date`);
    avoirWhere.push(`a.date_emission >= ${bound}::date`);
  }
  if (query.to) {
    const bound = p.push(query.to);
    factureWhere.push(`f.date_emission <= ${bound}::date`);
    avoirWhere.push(`a.date_emission <= ${bound}::date`);
  }

  const periodExpr = granularityExpr(query.granularity, "x.date_value");

  const sql = `
    WITH x AS (
      SELECT
        f.date_emission           AS date_value,
        f.total_ttc::numeric(18,2) AS total_ttc,
        f.total_ht::numeric(18,2)  AS total_ht,
        1::int AS count_factures,
        0::int AS count_avoirs
      FROM facture f
      WHERE ${factureWhere.join(" AND ")}

      UNION ALL

      SELECT
        a.date_emission             AS date_value,
        (-a.total_ttc)::numeric(18,2) AS total_ttc,
        (-a.total_ht)::numeric(18,2)  AS total_ht,
        0::int AS count_factures,
        1::int AS count_avoirs
      FROM avoir a
      WHERE ${avoirWhere.join(" AND ")}
    )
    SELECT
      (${periodExpr})::text AS period,
      COALESCE(SUM(x.total_ttc), 0)::numeric(18,2)::text AS total_ttc,
      COALESCE(SUM(x.total_ht), 0)::numeric(18,2)::text  AS total_ht,
      COALESCE(SUM(x.count_factures), 0)::int AS count_factures,
      COALESCE(SUM(x.count_avoirs), 0)::int   AS count_avoirs
    FROM x
    GROUP BY (${periodExpr})
    ORDER BY (${periodExpr}) ASC
  `;

  const res = await pool.query(sql, p.values);
  const buckets: RevenueBucket[] = res.rows.map((row) => ({
    period: String(row.period),
    total_ttc: money(row.total_ttc),
    total_ht: money(row.total_ht),
    count_factures: count(row.count_factures),
    count_avoirs: count(row.count_avoirs),
  }));
  return { buckets };
}

/**
 * Encours client à une date d'arrêté.
 *
 * Reconstruction stricte : seules les factures entrées au registre au plus tard à
 * `as_of`, diminuées des règlements encaissés ET imputés au plus tard à `as_of` et des
 * avoirs finalisés ET imputés au plus tard à `as_of`. Rien de postérieur n'entre.
 */
export async function repoCommercialOutstanding(query: OutstandingQueryDTO): Promise<OutstandingSummary> {
  const asOf = query.as_of ?? todayInParis();

  const p = new Params();
  const ledger = ledgerFactureCte(p, { asOf, basis: "document_date" });
  const settled = settledCte(p, asOf);
  const credited = creditedCte(p, asOf, "document_date");
  const asOfParam = p.push(asOf);

  const summarySql = `
    WITH ${ledger},
    ${settled},
    ${credited},
    ${balancesCte()}
    SELECT
      COALESCE(SUM(b.balance_ttc) FILTER (WHERE b.balance_ttc > 0), 0)::numeric(18,2)::text AS outstanding_ttc,
      COALESCE(
        SUM(b.balance_ttc) FILTER (WHERE b.balance_ttc > 0 AND b.due_date < ${asOfParam}::date),
        0
      )::numeric(18,2)::text AS overdue_ttc,
      COALESCE(SUM(-b.balance_ttc) FILTER (WHERE b.balance_ttc < 0), 0)::numeric(18,2)::text AS credit_balance_ttc,
      COUNT(*) FILTER (WHERE b.balance_ttc > 0)::int AS count_outstanding,
      COUNT(*) FILTER (WHERE b.balance_ttc > 0 AND b.due_date < ${asOfParam}::date)::int AS count_overdue,
      COUNT(*) FILTER (WHERE b.balance_ttc < 0)::int AS count_credit_balance
    FROM balances b
  `;

  const summaryRes = await pool.query(summarySql, p.values);
  const summaryRow = summaryRes.rows[0] ?? {};

  const listParams = new Params();
  const listLedger = ledgerFactureCte(listParams, { asOf, basis: "document_date" });
  const listSettled = settledCte(listParams, asOf);
  const listCredited = creditedCte(listParams, asOf, "document_date");
  const listAsOf = listParams.push(asOf);
  const listLimit = listParams.push(query.limit);

  const overdueSql = `
    WITH ${listLedger},
    ${listSettled},
    ${listCredited},
    ${balancesCte()}
    SELECT
      b.id::text AS id,
      b.numero,
      b.client_id,
      c.company_name,
      b.date_emission::text AS date_emission,
      b.date_echeance::text AS date_echeance,
      b.total_ttc::text     AS total_ttc,
      b.settled_ttc::text   AS total_paye_ttc,
      b.credited_ttc::text  AS total_avoirs_ttc,
      b.balance_ttc::text   AS reste_a_payer_ttc
    FROM balances b
    LEFT JOIN clients c ON c.client_id = b.client_id
    WHERE b.balance_ttc > 0
      AND b.due_date < ${listAsOf}::date
    ORDER BY b.balance_ttc DESC, b.id DESC
    LIMIT ${listLimit}
  `;

  const overdueRes = await pool.query(overdueSql, listParams.values);
  const overdue_invoices: OutstandingRow[] = overdueRes.rows.map((row) => ({
    id: toInt(row.id, "facture.id"),
    numero: String(row.numero),
    client_id: String(row.client_id),
    company_name: row.company_name ?? null,
    date_emission: String(row.date_emission),
    date_echeance: row.date_echeance ?? null,
    total_ttc: money(row.total_ttc),
    total_paye_ttc: money(row.total_paye_ttc),
    total_avoirs_ttc: money(row.total_avoirs_ttc),
    reste_a_payer_ttc: money(row.reste_a_payer_ttc),
  }));

  const unallocated = await repoUnallocatedAtDate(asOf);

  return {
    as_of: asOf,
    outstanding_ttc: money(summaryRow.outstanding_ttc),
    overdue_ttc: money(summaryRow.overdue_ttc),
    count_outstanding: count(summaryRow.count_outstanding),
    count_overdue: count(summaryRow.count_overdue),
    overdue_invoices,
    credit_balance_ttc: money(summaryRow.credit_balance_ttc),
    count_credit_balance: count(summaryRow.count_credit_balance),
    unallocated_payments_ttc: unallocated.payments_ttc,
    unallocated_credits_ttc: unallocated.credits_ttc,
    truncated: count(summaryRow.count_overdue) > overdue_invoices.length,
    metric_ids: [
      "receivables.open.amount_ttc",
      "receivables.overdue.amount_ttc",
      "receivables.credit_balance.amount_ttc",
      "receivables.unallocated_payments.amount_ttc",
      "receivables.unallocated_credits.amount_ttc",
    ],
  };
}

/**
 * Règlements et avoirs encaissés/finalisés à `as_of` mais non imputés à cette date.
 * Ils ne réduisent aucune créance : les exposer séparément évite de faire croire à
 * un lettrage qui n'existe pas.
 */
export async function repoUnallocatedAtDate(
  asOf: string
): Promise<{ payments_ttc: number; credits_ttc: number }> {
  const p = new Params();
  const asOfParam = p.push(asOf);
  const net = paiementNetPredicate(p, "p");
  const avoirStatuses = p.push([...AVOIR_LEDGER_STATUSES]);

  const sql = `
    WITH pay AS (
      SELECT
        p.id,
        ${paiementAvailableAmountExpression("p", {
          allocationAsOfDateSql: `${asOfParam}::date`,
        })}::numeric(18,2) AS available
      FROM paiement p
      WHERE p.date_paiement <= ${asOfParam}::date
        AND ${net}
    ),
    cred AS (
      SELECT
        a.id,
        a.total_ttc::numeric(18,2) AS montant,
        COALESCE((
          SELECT SUM(asa.amount_ttc)
          FROM avoir_source_allocations asa
          WHERE asa.avoir_id = a.id
            AND asa.allocation_status <> 'REVERSED'
            AND (asa.created_at AT TIME ZONE 'Europe/Paris')::date <= ${asOfParam}::date
        ), 0)::numeric(18,2) AS allocated
      FROM avoir a
      WHERE a.statut = ANY(${avoirStatuses}::text[])
        AND a.date_emission <= ${asOfParam}::date
        AND a.facture_id IS NULL
    )
    SELECT
      COALESCE((SELECT SUM(available) FROM pay), 0)::numeric(18,2)::text AS payments_ttc,
      COALESCE((SELECT SUM(GREATEST(montant - allocated, 0)) FROM cred), 0)::numeric(18,2)::text AS credits_ttc
  `;

  const res = await pool.query(sql, p.values);
  const row = res.rows[0] ?? {};
  return { payments_ttc: money(row.payments_ttc), credits_ttc: money(row.credits_ttc) };
}

/**
 * Classement des clients par facturé net TTC sur la période.
 * Périmètre de statuts strictement identique à `repoCommercialRevenue` : c'est ce qui
 * garantit que la somme de tous les clients égale le total de la période.
 */
export async function repoCommercialTopClients(query: TopClientsQueryDTO): Promise<{ items: TopClientRow[] }> {
  const p = new Params();
  const factureWhere: string[] = [
    `f.statut = ANY(${p.push(factureStatuses(query.include_brouillon))}::text[])`,
  ];
  const avoirWhere: string[] = [`a.statut = ANY(${p.push([...AVOIR_LEDGER_STATUSES])}::text[])`];

  if (query.from) {
    const bound = p.push(query.from);
    factureWhere.push(`f.date_emission >= ${bound}::date`);
    avoirWhere.push(`a.date_emission >= ${bound}::date`);
  }
  if (query.to) {
    const bound = p.push(query.to);
    factureWhere.push(`f.date_emission <= ${bound}::date`);
    avoirWhere.push(`a.date_emission <= ${bound}::date`);
  }
  const limitParam = p.push(query.limit);

  const sql = `
    WITH amounts AS (
      SELECT f.client_id, f.total_ttc::numeric(18,2) AS amount_ttc, 1::int AS count_factures, 0::int AS count_avoirs
      FROM facture f
      WHERE ${factureWhere.join(" AND ")}

      UNION ALL

      SELECT a.client_id, (-a.total_ttc)::numeric(18,2) AS amount_ttc, 0::int AS count_factures, 1::int AS count_avoirs
      FROM avoir a
      WHERE ${avoirWhere.join(" AND ")}
    )
    SELECT
      am.client_id,
      c.company_name,
      COALESCE(SUM(am.amount_ttc), 0)::numeric(18,2)::text AS total_ttc,
      COALESCE(SUM(am.count_factures), 0)::int AS count_factures,
      COALESCE(SUM(am.count_avoirs), 0)::int   AS count_avoirs
    FROM amounts am
    LEFT JOIN clients c ON c.client_id = am.client_id
    GROUP BY am.client_id, c.company_name
    ORDER BY COALESCE(SUM(am.amount_ttc), 0) DESC
    LIMIT ${limitParam}
  `;

  const res = await pool.query(sql, p.values);
  const items: TopClientRow[] = res.rows.map((row) => ({
    client_id: String(row.client_id),
    company_name: row.company_name ?? null,
    total_ttc: money(row.total_ttc),
    count_factures: count(row.count_factures),
    count_avoirs: count(row.count_avoirs),
  }));
  return { items };
}

export { DEFAULT_CURRENCY };
