import type { PoolClient } from "pg";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import {
  ADV_RELIABILITY_CONTRACT_VERSION,
  ADV_RELIABILITY_TIMEZONE,
  advPayloadHash,
  agingBucket,
  assessEInvoiceReadiness,
  calendarAgeDays,
  classifyDeliveryQueue,
  computeCashForecast,
  computeDsoDays,
  reliabilityFromCoverage,
} from "../domain/adv-reliability";
import type {
  AdvOverviewQueryDTO,
  DeliveryBlockBodyDTO,
  InvoiceDisputeBodyDTO,
  InvoiceDisputeStatusBodyDTO,
  PaymentPromiseBodyDTO,
  PaymentPromiseStatusBodyDTO,
  ResolveCaseBodyDTO,
} from "../validators/adv-reliability.validators";
import { moneyToCents } from "../../facturation/domain/decimal-money";
import {
  Params,
  balancesCte,
  creditedCte,
  ledgerFactureCte,
  paiementNetPredicate,
  settledCte,
} from "../../facturation/repository/reporting-sql";

type Queryer = Pick<PoolClient, "query">;
type AdvCommandAction = "DELIVERY_BLOCK_CREATE" | "DELIVERY_BLOCK_RESOLVE" | "PAYMENT_PROMISE_CREATE" | "PAYMENT_PROMISE_STATUS" | "INVOICE_DISPUTE_CREATE" | "INVOICE_DISPUTE_STATUS";

export type AdvActor = {
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

function int(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numeric(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? parsed : 0;
}

function moneyText(value: unknown): string {
  const raw = String(value ?? "0.00");
  return (Number.parseFloat(raw) || 0).toFixed(2);
}

async function ensureInstalled(queryer: Queryer = db): Promise<void> {
  const result = await queryer.query<{ installed: boolean }>(`
    SELECT to_regclass('public.adv_delivery_blocks') IS NOT NULL
       AND to_regclass('public.adv_payment_promises') IS NOT NULL
       AND to_regclass('public.adv_invoice_disputes') IS NOT NULL
       AND to_regclass('public.adv_case_events') IS NOT NULL
       AND to_regclass('public.adv_otif_assessments') IS NOT NULL
       AND to_regclass('public.adv_command_receipts') IS NOT NULL AS installed
  `);
  if (!result.rows[0]?.installed) {
    throw new HttpError(503, "ADV_RELIABILITY_NOT_INSTALLED", "Le patch SOL-23 doit être appliqué avant d'utiliser le cockpit ADV.");
  }
}

async function inTransaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertAudit(tx: Queryer, actor: AdvActor, entry: { action: string; entity_type: string; entity_id: string; details: Record<string, unknown> }) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: actor.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: actor.path,
    client_session_id: actor.client_session_id,
    details: entry.details,
  };
  await repoInsertAuditLog({ user_id: actor.user_id, body, ip: actor.ip, user_agent: actor.user_agent, device_type: null, os: null, browser: null, tx });
}

async function readReceipt<T>(tx: Queryer, action: AdvCommandAction, key: string, hash: string): Promise<T | null> {
  const result = await tx.query<{ request_hash: string; response_snapshot: T }>(
    `SELECT request_hash,response_snapshot FROM public.adv_command_receipts WHERE action=$1 AND idempotency_key=$2 FOR SHARE`,
    [action, key],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "Cette clé d'idempotence a déjà servi avec une demande différente.");
  return { ...(row.response_snapshot as Record<string, unknown>), idempotent_replay: true } as T;
}

async function saveReceipt(tx: Queryer, action: AdvCommandAction, key: string, hash: string, actorId: number, response: unknown) {
  await tx.query(
    `INSERT INTO public.adv_command_receipts(action,idempotency_key,request_hash,actor_user_id,response_snapshot)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [action, key, hash, actorId, JSON.stringify(response)],
  );
}

async function appendCaseEvent(tx: Queryer, params: { caseType: string; caseId: string; eventType: string; actorId: number; snapshot: unknown }) {
  await tx.query(
    `INSERT INTO public.adv_case_events(case_type,case_id,event_type,actor_user_id,snapshot)
     VALUES ($1,$2::uuid,$3,$4,$5::jsonb)`,
    [params.caseType, params.caseId, params.eventType, params.actorId, JSON.stringify(params.snapshot)],
  );
}

async function loadDeliveryQueue(query: AdvOverviewQueryDTO, asOf: string) {
  const values: unknown[] = [query.to, query.limit];
  const clientFilter = query.client_id ? `AND cc.client_id=$${values.push(query.client_id)}::text ` : "";
  const result = await db.query<Record<string, unknown>>(`
    WITH shipped AS (
      SELECT bll.commande_ligne_id, SUM(bll.quantite)::numeric(18,3) AS shipped_qty,
             MAX(COALESCE(bl.date_expedition,bl.date_livraison,bl.date_creation))::date AS last_ship_date
        FROM public.bon_livraison_ligne bll
        JOIN public.bon_livraison bl ON bl.id=bll.bon_livraison_id
       WHERE bll.commande_ligne_id IS NOT NULL AND bl.statut IN ('SHIPPED','DELIVERED')
       GROUP BY bll.commande_ligne_id
    ), line_facts AS (
      SELECT cc.id AS order_id,cc.numero,cc.client_id,c.company_name,
             cl.id AS line_id,cl.delai_client,cl.quantite::numeric(18,3) AS ordered_qty,
             GREATEST(cl.quantite-COALESCE(s.shipped_qty,0),0)::numeric(18,3) AS remaining_qty,
             s.last_ship_date
        FROM public.commande_client cc
        JOIN public.commande_ligne cl ON cl.commande_id=cc.id
        LEFT JOIN public.clients c ON c.client_id=cc.client_id
        LEFT JOIN shipped s ON s.commande_ligne_id=cl.id
       WHERE COALESCE(cc.order_type,'FERME') <> 'INTERNE' ${clientFilter}
    ), orders AS (
      SELECT order_id,numero,client_id,company_name,
             MIN(delai_client) FILTER (WHERE remaining_qty>0)::text AS due_date,
             SUM(ordered_qty)::text AS ordered_qty,SUM(remaining_qty)::text AS remaining_qty,
             MAX(last_ship_date)::text AS last_ship_date
        FROM line_facts GROUP BY order_id,numero,client_id,company_name
    ), deliveries AS (
      SELECT commande_id,
             COUNT(*) FILTER (WHERE statut='READY')::int AS ready_count,
             COALESCE(jsonb_agg(jsonb_build_object('id',id::text,'numero',numero,'status',statut,
               'planned_date',date_livraison::text,'shipped_at',date_expedition::text,'updated_at',updated_at::text)
               ORDER BY date_creation,id) FILTER (WHERE statut<>'CANCELLED'),'[]'::jsonb) AS rows
        FROM public.bon_livraison WHERE commande_id IS NOT NULL GROUP BY commande_id
    )
    SELECT o.*,COALESCE(d.ready_count,0) AS ready_count,d.rows,
           b.id::text AS block_id,b.delivery_id::text,b.category AS block_category,b.detail AS block_detail,
           b.owner_user_id,u.username AS owner_name,b.next_action,b.due_date::text AS action_due_date,
           b.created_at::text AS blocked_at,b.updated_at::text AS block_updated_at
      FROM orders o
      LEFT JOIN deliveries d ON d.commande_id=o.order_id
      LEFT JOIN LATERAL (
        SELECT ab.* FROM public.adv_delivery_blocks ab
         WHERE ab.order_id=o.order_id AND ab.status='OPEN'
         ORDER BY ab.created_at,ab.id LIMIT 1
      ) b ON TRUE
      LEFT JOIN public.users u ON u.id=b.owner_user_id
     WHERE o.remaining_qty::numeric>0
       AND (o.due_date::date <= $1::date OR o.due_date IS NULL)
     ORDER BY (o.due_date IS NULL),o.due_date,o.order_id
     LIMIT $2
  `, values);
  return result.rows.map((row) => {
    const dueDate = row.due_date === null ? null : String(row.due_date);
    const remaining = numeric(row.remaining_qty);
    const blocked = row.block_id !== null;
    const ready = int(row.ready_count) > 0;
    return {
      order_id: int(row.order_id), numero: String(row.numero), client_id: String(row.client_id), company_name: row.company_name === null ? null : String(row.company_name),
      due_date: dueDate, ordered_qty: numeric(row.ordered_qty), remaining_qty: remaining,
      state: classifyDeliveryQueue({ dueDate, asOf, remainingQuantity: remaining, ready, blocked }),
      aging_days: calendarAgeDays(dueDate, asOf), deliveries: Array.isArray(row.rows) ? row.rows : [],
      block: blocked ? {
        id: String(row.block_id), delivery_id: String(row.delivery_id), category: String(row.block_category), detail: String(row.block_detail),
        owner_user_id: row.owner_user_id === null ? null : int(row.owner_user_id), owner_name: row.owner_name === null ? null : String(row.owner_name),
        next_action: String(row.next_action), due_date: String(row.action_due_date), blocked_at: String(row.blocked_at), updated_at: String(row.block_updated_at),
      } : null,
    };
  });
}

async function loadOtif(query: AdvOverviewQueryDTO, asOf: string) {
  const values: unknown[] = [asOf, query.from, query.to];
  const clientFilter = query.client_id ? `AND cc.client_id=$${values.push(query.client_id)} ` : "";
  const result = await db.query<Record<string, unknown>>(`
    WITH shipped_daily AS (
      SELECT bll.commande_ligne_id,COALESCE(bl.date_expedition,bl.date_livraison,bl.date_creation)::date AS ship_date,
             SUM(bll.quantite)::numeric(18,3) AS qty
        FROM public.bon_livraison_ligne bll JOIN public.bon_livraison bl ON bl.id=bll.bon_livraison_id
       WHERE bl.statut IN ('SHIPPED','DELIVERED') AND COALESCE(bl.date_expedition,bl.date_livraison,bl.date_creation)::date <= $1::date
       GROUP BY bll.commande_ligne_id,COALESCE(bl.date_expedition,bl.date_livraison,bl.date_creation)::date
    ), progress AS (
      SELECT commande_ligne_id,ship_date,SUM(qty) OVER(PARTITION BY commande_ligne_id ORDER BY ship_date)::numeric(18,3) AS cumulative_qty FROM shipped_daily
    ), line_completion AS (
      SELECT cl.commande_id,cl.id,cl.delai_client,cl.quantite,
             (SELECT MIN(p.ship_date) FROM progress p WHERE p.commande_ligne_id=cl.id AND p.cumulative_qty>=cl.quantite) AS completion_date
        FROM public.commande_ligne cl
    ), derived AS (
      SELECT cc.id AS order_id,MAX(lc.delai_client)::date AS promised_date,MAX(lc.completion_date)::date AS completion_date,
             BOOL_AND(lc.delai_client IS NOT NULL) AS eligible,
             BOOL_AND(lc.completion_date IS NOT NULL AND lc.completion_date<=lc.delai_client) AS pass
        FROM public.commande_client cc JOIN line_completion lc ON lc.commande_id=cc.id
       WHERE COALESCE(cc.order_type,'FERME')<>'INTERNE' ${clientFilter}
       GROUP BY cc.id
    ), population AS (
      SELECT d.*,a.on_time_in_full AS frozen_pass,a.id IS NOT NULL AS frozen
        FROM derived d LEFT JOIN public.adv_otif_assessments a ON a.order_id=d.order_id
       WHERE d.eligible AND d.completion_date IS NOT NULL AND d.promised_date BETWEEN $2::date AND $3::date
    )
    SELECT COUNT(*)::int AS eligible,
           COUNT(*) FILTER (WHERE COALESCE(frozen_pass,pass))::int AS passed,
           COUNT(*) FILTER (WHERE frozen)::int AS frozen,
           COALESCE(jsonb_agg(jsonb_build_object('order_id',order_id,'promised_date',promised_date::text,
             'completion_date',completion_date::text,'pass',COALESCE(frozen_pass,pass),'evidence',CASE WHEN frozen THEN 'FROZEN' ELSE 'CURRENT_DERIVED' END)
             ORDER BY promised_date,order_id),'[]'::jsonb) AS evidence
      FROM population
  `, values);
  const row = result.rows[0] ?? {};
  const eligible = int(row.eligible);
  const passed = int(row.passed);
  const frozen = int(row.frozen);
  return {
    value_pct: eligible > 0 ? Math.round((passed / eligible) * 10_000) / 100 : null,
    numerator: passed, denominator: eligible, frozen_evidence_count: frozen,
    current_derived_count: Math.max(0, eligible - frozen),
    reliability: reliabilityFromCoverage(eligible, frozen),
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
  };
}

async function loadFinance(query: AdvOverviewQueryDTO, asOf: string) {
  const p = new Params();
  const ledger = ledgerFactureCte(p, { asOf, basis: "document_date", clientId: query.client_id, currency: query.currency });
  const settled = settledCte(p, asOf);
  const credited = creditedCte(p, asOf, "document_date");
  const horizon = p.push(asOf);
  const limit = p.push(query.limit);
  const result = await db.query<Record<string, unknown>>(`
    WITH ${ledger},${settled},${credited},${balancesCte()},
    schedules AS (
      SELECT fe.facture_id,SUM(GREATEST(fe.amount_due-fe.amount_allocated,0))::numeric(18,2) AS amount
        FROM public.facture_echeance fe
       WHERE fe.status IN ('OPEN','PARTIALLY_PAID','OVERDUE') AND fe.due_date BETWEEN ${horizon}::date AND (${horizon}::date+30)
       GROUP BY fe.facture_id
    ), promises AS (
      SELECT facture_id,SUM(amount_ttc)::numeric(18,2) AS amount
        FROM public.adv_payment_promises
       WHERE status='OPEN' AND promised_date BETWEEN ${horizon}::date AND (${horizon}::date+30)
       GROUP BY facture_id
    ), disputes AS (
      SELECT facture_id,COUNT(*)::int AS open_count,SUM(COALESCE(disputed_amount_ttc,0))::numeric(18,2) AS disputed_ttc
        FROM public.adv_invoice_disputes WHERE status='OPEN' GROUP BY facture_id
    )
    SELECT b.id::text,b.numero,b.client_id,c.company_name,b.currency,b.date_emission::text,b.date_echeance::text,
           b.total_ttc::text,b.balance_ttc::text,b.settled_ttc::text,b.credited_ttc::text,
           COALESCE(s.amount,0)::text AS scheduled_ttc,COALESCE(p.amount,0)::text AS promised_ttc,
           COALESCE(d.open_count,0) AS dispute_count,COALESCE(d.disputed_ttc,0)::text AS disputed_ttc,
           f.legal_number,f.statut,f.updated_at::text
      FROM balances b JOIN public.facture f ON f.id=b.id LEFT JOIN public.clients c ON c.client_id=b.client_id
      LEFT JOIN schedules s ON s.facture_id=b.id LEFT JOIN promises p ON p.facture_id=b.id LEFT JOIN disputes d ON d.facture_id=b.id
     WHERE b.balance_ttc>0 ORDER BY b.date_echeance NULLS LAST,b.id LIMIT ${limit}
  `, p.values);
  const invoices = result.rows.map((row) => {
    const forecast = computeCashForecast({ invoiceId: String(row.id), currency: String(row.currency), balanceTtc: moneyText(row.balance_ttc), scheduledWithinHorizonTtc: moneyText(row.scheduled_ttc), promisedWithinHorizonTtc: moneyText(row.promised_ttc) });
    return {
      id: String(row.id), numero: String(row.numero), client_id: String(row.client_id), company_name: row.company_name === null ? null : String(row.company_name),
      currency: String(row.currency), issue_date: String(row.date_emission), due_date: row.date_echeance === null ? null : String(row.date_echeance),
      balance_ttc: moneyText(row.balance_ttc), settled_ttc: moneyText(row.settled_ttc), credited_ttc: moneyText(row.credited_ttc),
      aging_bucket: agingBucket(row.date_echeance === null ? null : String(row.date_echeance), asOf),
      dispute: { open_count: int(row.dispute_count), disputed_ttc: moneyText(row.disputed_ttc) }, forecast,
      e_invoice_readiness: assessEInvoiceReadiness({ issued: ["ISSUED","PARTIALLY_PAID","PAID","emis","emise","envoyee","partielle","payee"].includes(String(row.statut)), legalNumber: row.legal_number === null ? null : String(row.legal_number), currency: row.currency === null ? null : String(row.currency), clientId: row.client_id === null ? null : String(row.client_id), totalTtc: row.total_ttc === null ? null : String(row.total_ttc) }),
      freshness_at: String(row.updated_at),
    };
  });

  const salesParams: unknown[] = [asOf, query.client_id ?? null, query.currency ?? null];
  const sales = await db.query<Record<string, unknown>>(`
    SELECT UPPER(COALESCE(currency,'EUR')) AS currency,SUM(total_ttc)::numeric(18,2)::text AS issued_ttc
      FROM public.facture
     WHERE statut IN ('ISSUED','PARTIALLY_PAID','PAID','emis','emise','envoyee','partielle','payee')
       AND date_emission BETWEEN ($1::date-364) AND $1::date
       AND ($2::text IS NULL OR client_id=$2)
       AND ($3::text IS NULL OR UPPER(COALESCE(currency,'EUR'))=$3)
     GROUP BY UPPER(COALESCE(currency,'EUR'))
  `, salesParams);
  const issuedByCurrency = new Map(sales.rows.map((row) => [String(row.currency), moneyText(row.issued_ttc)]));
  const grouped = new Map<string, { open: bigint; scheduled: bigint; promised: bigint; expected: bigint; count: number }>();
  for (const invoice of invoices) {
    const current = grouped.get(invoice.currency) ?? { open: 0n, scheduled: 0n, promised: 0n, expected: 0n, count: 0 };
    current.open += moneyToCents(invoice.balance_ttc);
    current.scheduled += moneyToCents(invoice.forecast.scheduled_ttc);
    current.promised += moneyToCents(invoice.forecast.promised_ttc);
    current.expected += moneyToCents(invoice.forecast.expected_ttc);
    current.count += 1;
    grouped.set(invoice.currency, current);
  }
  const currencies = [...grouped.entries()].map(([currency, value]) => ({
    currency, invoice_count: value.count, open_ttc: (Number(value.open) / 100).toFixed(2),
    scheduled_30d_ttc: (Number(value.scheduled) / 100).toFixed(2), promised_30d_ttc: (Number(value.promised) / 100).toFixed(2),
    expected_30d_ttc: (Number(value.expected) / 100).toFixed(2), issued_365d_ttc: issuedByCurrency.get(currency) ?? "0.00",
    dso_days: computeDsoDays((Number(value.open) / 100).toFixed(2), issuedByCurrency.get(currency) ?? "0.00"),
  }));
  return { currencies, invoices };
}

export async function repoAdvOverview(query: AdvOverviewQueryDTO) {
  await ensureInstalled();
  const asOf = query.as_of ?? new Date().toISOString().slice(0, 10);
  const [deliveries, otif, finance] = await Promise.all([loadDeliveryQueue(query, asOf), loadOtif(query, asOf), loadFinance(query, asOf)]);
  const counts = { due: 0, ready: 0, blocked: 0, late: 0, planned: 0 };
  for (const item of deliveries) {
    if (item.state === "DUE") counts.due += 1;
    else if (item.state === "READY") counts.ready += 1;
    else if (item.state === "BLOCKED") counts.blocked += 1;
    else if (item.state === "LATE") counts.late += 1;
    else if (item.state === "PLANNED") counts.planned += 1;
  }
  return {
    contract_version: ADV_RELIABILITY_CONTRACT_VERSION,
    generated_at: new Date().toISOString(), timezone: ADV_RELIABILITY_TIMEZONE,
    period: { from: query.from, to: query.to, as_of: asOf },
    delivery: {
      counts, otif, queue: deliveries,
      metric_definition: { unit: "orders", period: "open promises due no later than period end", source: ["commande_client","commande_ligne","bon_livraison","adv_delivery_blocks"], freshness_at: new Date().toISOString(), reliability: deliveries.some((row) => row.due_date === null) ? "PARTIAL" : "ACTUAL" },
    },
    finance: {
      ...finance,
      metric_definitions: {
        dso: { unit: "calendar_days", formula: "open_receivables_ttc / issued_ttc_last_365_days × 365", period: "rolling_365_days", source: ["facture","paiement_allocations","avoir_source_allocations"], reliability: "ACTUAL" },
        cash_30d: { unit: "currency", formula: "active promises first + due schedules on residual balance, capped at invoice balance", period: "as_of through as_of+30d", source: ["facture_echeance","adv_payment_promises","paiement_allocations","avoir_source_allocations"], reliability: "PARTIAL" },
      },
    },
    electronic_invoicing: { scope: "INTERNAL_READINESS_ONLY", connector: { available: false, status: "UNAVAILABLE", reason: "NO_PROVIDER_SELECTED" }, statuses: ["NOT_ASSESSED","BLOCKED","READY_FOR_CONNECTOR"] },
    existing_finance_capabilities: { partial_invoices: true, credit_notes: true, schedules: true, reconciled_payments: true },
  };
}

export async function repoAdvOrderChain(orderId: number) {
  await ensureInstalled();
  const order = await db.query<Record<string, unknown>>(`SELECT cc.id::text,cc.numero,cc.client_id,cc.devis_id::text,c.company_name FROM public.commande_client cc LEFT JOIN public.clients c ON c.client_id=cc.client_id WHERE cc.id=$1`, [orderId]);
  if (!order.rows[0]) throw new HttpError(404, "ORDER_NOT_FOUND", "Commande client introuvable.");
  const [deliveries, invoices, affairs, ofs] = await Promise.all([
    db.query(`SELECT bl.id::text,bl.numero,bl.statut AS status,bl.date_expedition::text,bl.date_livraison::text,
      COALESCE(jsonb_agg(jsonb_build_object('id',bll.id::text,'order_line_id',bll.commande_ligne_id::text,'quantity',bll.quantite::text) ORDER BY bll.ordre) FILTER(WHERE bll.id IS NOT NULL),'[]'::jsonb) AS lines
      FROM public.bon_livraison bl LEFT JOIN public.bon_livraison_ligne bll ON bll.bon_livraison_id=bl.id WHERE bl.commande_id=$1 GROUP BY bl.id ORDER BY bl.date_creation,bl.id`, [orderId]),
    db.query(`SELECT f.id::text,f.numero,f.statut AS status,f.total_ht::text,f.total_ttc::text,f.currency,f.date_emission::text,f.date_echeance::text,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('payment_id',p.id::text,'date',p.date_paiement::text,'amount_ttc',pa.amount_ttc::text,'status',p.status) ORDER BY p.date_paiement,p.id) FROM public.paiement_allocations pa JOIN public.paiement p ON p.id=pa.paiement_id WHERE pa.facture_id=f.id),'[]'::jsonb) AS payments,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('credit_id',a.id::text,'number',a.numero,'amount_ttc',aa.amount_ttc::text,'status',a.statut) ORDER BY a.date_emission,a.id) FROM public.avoir_source_allocations aa JOIN public.avoir a ON a.id=aa.avoir_id WHERE aa.facture_id=f.id),'[]'::jsonb) AS credits,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',d.id::text,'category',d.category,'status',d.status,'amount_ttc',d.disputed_amount_ttc::text,'next_action',d.next_action,'due_date',d.due_date::text) ORDER BY d.created_at) FROM public.adv_invoice_disputes d WHERE d.facture_id=f.id),'[]'::jsonb) AS disputes,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',pp.id::text,'status',pp.status,'amount_ttc',pp.amount_ttc::text,'promised_date',pp.promised_date::text,'next_action',pp.next_action) ORDER BY pp.created_at) FROM public.adv_payment_promises pp WHERE pp.facture_id=f.id),'[]'::jsonb) AS promises
      FROM public.facture f WHERE f.commande_id=$1 OR EXISTS(SELECT 1 FROM public.facture_source_allocations fsa JOIN public.bon_livraison_ligne bll ON bll.id::text=fsa.source_line_id JOIN public.bon_livraison bl ON bl.id=bll.bon_livraison_id WHERE fsa.facture_id=f.id AND fsa.source_type='DELIVERY_LINE' AND bl.commande_id=$1) ORDER BY f.date_emission,f.id`, [orderId]),
    db.query(`SELECT id::text,reference,numero FROM public.affaire WHERE commande_id=$1 OR id IN (SELECT affaire_id FROM public.commande_to_affaire WHERE commande_id=$1)`, [orderId]),
    db.query(`SELECT id::text,numero,affaire_id::text FROM public.ordres_fabrication WHERE commande_id=$1 OR commande_ligne_id IN (SELECT id FROM public.commande_ligne WHERE commande_id=$1)`, [orderId]),
  ]);
  const base = order.rows[0];
  const marginScopes = [
    ...(base.devis_id ? [{ type: "DEVIS", ref: String(base.devis_id) }] : []),
    ...affairs.rows.map((row) => ({ type: "AFFAIRE", ref: String(row.id) })),
    ...ofs.rows.map((row) => ({ type: "OF", ref: String(row.id) })),
  ];
  const margins = marginScopes.length === 0 ? [] : (await db.query<Record<string, unknown>>(`
    SELECT DISTINCT ON (scope_type,scope_ref,basis) scope_type,scope_ref,basis,as_of::text,created_at::text,
           result_snapshot->>'reliability' AS reliability,result_snapshot->>'availability' AS availability,
           result_snapshot->>'gross_margin_ht' AS gross_margin_ht,result_snapshot->>'currency' AS currency,
           calculation_hash
      FROM public.margin_recalculations
     WHERE (scope_type,scope_ref) IN (${marginScopes.map((_, index) => `($${index * 2 + 1},$${index * 2 + 2})`).join(",")})
     ORDER BY scope_type,scope_ref,basis,created_at DESC
  `, marginScopes.flatMap((scope) => [scope.type, scope.ref]))).rows;
  return {
    contract_version: ADV_RELIABILITY_CONTRACT_VERSION,
    order: base, deliveries: deliveries.rows, invoices: invoices.rows,
    production: { affairs: affairs.rows, manufacturing_orders: ofs.rows },
    margins: { links: marginScopes.map((scope) => ({ ...scope, endpoint: `/api/v1/margins/${scope.type.toLowerCase()}/${scope.ref}` })), snapshots: margins, reliability_authority: "SOL-13 margin engine" },
    chain: "order → delivery → invoice → payment/credit → margin",
  };
}

async function invoiceIdentity(tx: Queryer, invoiceId: number) {
  const result = await tx.query<Record<string, unknown>>(`
    SELECT f.id,f.client_id,UPPER(COALESCE(f.currency,'EUR')) AS currency,f.total_ttc::text,
           (f.total_ttc-COALESCE((SELECT SUM(pa.amount_ttc) FROM public.paiement_allocations pa JOIN public.paiement p ON p.id=pa.paiement_id WHERE pa.facture_id=f.id AND p.status NOT IN ('REJECTED','REVERSED')),0)
             -COALESCE((SELECT SUM(asa.amount_ttc) FROM public.avoir_source_allocations asa JOIN public.avoir a ON a.id=asa.avoir_id WHERE asa.facture_id=f.id AND asa.allocation_status='CONSUMED' AND a.statut IN ('ISSUED','emis','emise')),0))::numeric(18,2)::text AS balance_ttc
      FROM public.facture f WHERE f.id=$1 FOR UPDATE`, [invoiceId]);
  if (!result.rows[0]) throw new HttpError(404, "INVOICE_NOT_FOUND", "Facture introuvable.");
  return result.rows[0];
}

export async function repoCreateDeliveryBlock(params: { deliveryId: string; input: DeliveryBlockBodyDTO; actor: AdvActor; idempotencyKey: string }) {
  return inTransaction(async (tx) => {
    await ensureInstalled(tx);
    const hash = advPayloadHash({ delivery_id: params.deliveryId, ...params.input });
    const replay = await readReceipt<Record<string, unknown>>(tx, "DELIVERY_BLOCK_CREATE", params.idempotencyKey, hash); if (replay) return replay;
    const delivery = await tx.query(`SELECT id,commande_id FROM public.bon_livraison WHERE id=$1::uuid FOR UPDATE`, [params.deliveryId]);
    if (!delivery.rows[0]) throw new HttpError(404, "DELIVERY_NOT_FOUND", "Bon de livraison introuvable.");
    if (int(delivery.rows[0].commande_id) !== params.input.order_id) throw new HttpError(409, "DELIVERY_ORDER_MISMATCH", "Le bon de livraison n'appartient pas à cette commande.");
    let inserted;
    try {
      inserted = await tx.query<Record<string, unknown>>(`INSERT INTO public.adv_delivery_blocks(delivery_id,order_id,category,detail,owner_user_id,next_action,due_date,created_by,updated_by)
        VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id::text,status,created_at::text,updated_at::text`,
        [params.deliveryId,params.input.order_id,params.input.category,params.input.detail,params.input.owner_user_id,params.input.next_action,params.input.due_date,params.actor.user_id]);
    } catch (error) { if ((error as { code?: string }).code === "23505") throw new HttpError(409,"DELIVERY_BLOCK_ALREADY_OPEN","Un blocage de cette catégorie est déjà ouvert pour cette livraison."); throw error; }
    const response = { block: inserted.rows[0], idempotent_replay: false };
    await appendCaseEvent(tx,{caseType:"DELIVERY_BLOCK",caseId:String(inserted.rows[0]?.id),eventType:"OPENED",actorId:params.actor.user_id,snapshot:{delivery_id:params.deliveryId,...params.input}});
    await insertAudit(tx,params.actor,{action:"adv.delivery_block.opened",entity_type:"bon_livraison",entity_id:params.deliveryId,details:{block_id:inserted.rows[0]?.id,category:params.input.category,order_id:params.input.order_id}});
    await saveReceipt(tx,"DELIVERY_BLOCK_CREATE",params.idempotencyKey,hash,params.actor.user_id,response); return response;
  });
}

export async function repoResolveDeliveryBlock(params: { id: string; input: ResolveCaseBodyDTO; actor: AdvActor; idempotencyKey: string }) {
  return inTransaction(async (tx) => {
    await ensureInstalled(tx); const hash=advPayloadHash({id:params.id,...params.input}); const replay=await readReceipt<Record<string, unknown>>(tx,"DELIVERY_BLOCK_RESOLVE",params.idempotencyKey,hash); if(replay)return replay;
    const current=await tx.query<Record<string, unknown>>(`SELECT *,updated_at::text AS updated_at_text FROM public.adv_delivery_blocks WHERE id=$1::uuid FOR UPDATE`,[params.id]); const row=current.rows[0];
    if(!row)throw new HttpError(404,"DELIVERY_BLOCK_NOT_FOUND","Blocage de livraison introuvable.");
    if(String(row.status)!=="OPEN")throw new HttpError(409,"DELIVERY_BLOCK_ALREADY_CLOSED","Ce blocage est déjà résolu.");
    if(String(row.updated_at_text)!==params.input.expected_updated_at)throw new HttpError(409,"CONCURRENT_MODIFICATION","Le blocage a changé. Rechargez la file.");
    const updated=await tx.query<Record<string, unknown>>(`UPDATE public.adv_delivery_blocks SET status='RESOLVED',resolution_note=$2,resolved_at=now(),resolved_by=$3,updated_at=now(),updated_by=$3,version=version+1 WHERE id=$1::uuid RETURNING id::text,status,updated_at::text`,[params.id,params.input.resolution_note,params.actor.user_id]);
    const response={block:updated.rows[0],idempotent_replay:false}; await appendCaseEvent(tx,{caseType:"DELIVERY_BLOCK",caseId:params.id,eventType:"RESOLVED",actorId:params.actor.user_id,snapshot:{resolution_note:params.input.resolution_note}});
    await insertAudit(tx,params.actor,{action:"adv.delivery_block.resolved",entity_type:"bon_livraison",entity_id:String(row.delivery_id),details:{block_id:params.id}}); await saveReceipt(tx,"DELIVERY_BLOCK_RESOLVE",params.idempotencyKey,hash,params.actor.user_id,response);return response;
  });
}

export async function repoCreatePaymentPromise(params: { invoiceId: number; input: PaymentPromiseBodyDTO; actor: AdvActor; idempotencyKey: string }) {
  return inTransaction(async(tx)=>{await ensureInstalled(tx);const hash=advPayloadHash({invoice_id:params.invoiceId,...params.input});const replay=await readReceipt<Record<string,unknown>>(tx,"PAYMENT_PROMISE_CREATE",params.idempotencyKey,hash);if(replay)return replay;
    const invoice=await invoiceIdentity(tx,params.invoiceId);if(String(invoice.currency)!==params.input.currency)throw new HttpError(409,"PROMISE_CURRENCY_MISMATCH","La devise de la promesse doit être celle de la facture.");
    if(moneyToCents(params.input.amount_ttc)>moneyToCents(String(invoice.balance_ttc)))throw new HttpError(422,"PROMISE_EXCEEDS_BALANCE","La promesse dépasse le solde restant de la facture.");
    const inserted=await tx.query<Record<string,unknown>>(`INSERT INTO public.adv_payment_promises(facture_id,client_id,amount_ttc,currency,promised_date,owner_user_id,next_action,due_date,note,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id::text,status,created_at::text,updated_at::text`,[params.invoiceId,invoice.client_id,params.input.amount_ttc,params.input.currency,params.input.promised_date,params.input.owner_user_id,params.input.next_action,params.input.due_date,params.input.note??null,params.actor.user_id]);
    const response={promise:inserted.rows[0],idempotent_replay:false};await appendCaseEvent(tx,{caseType:"PAYMENT_PROMISE",caseId:String(inserted.rows[0]?.id),eventType:"OPENED",actorId:params.actor.user_id,snapshot:{invoice_id:params.invoiceId,...params.input}});await insertAudit(tx,params.actor,{action:"adv.payment_promise.recorded",entity_type:"facture",entity_id:String(params.invoiceId),details:{promise_id:inserted.rows[0]?.id,amount_ttc:params.input.amount_ttc,promised_date:params.input.promised_date}});await saveReceipt(tx,"PAYMENT_PROMISE_CREATE",params.idempotencyKey,hash,params.actor.user_id,response);return response;});
}

export async function repoUpdatePaymentPromise(params:{id:string;input:PaymentPromiseStatusBodyDTO;actor:AdvActor;idempotencyKey:string}){return inTransaction(async(tx)=>{await ensureInstalled(tx);const hash=advPayloadHash({id:params.id,...params.input});const replay=await readReceipt<Record<string,unknown>>(tx,"PAYMENT_PROMISE_STATUS",params.idempotencyKey,hash);if(replay)return replay;const current=await tx.query<Record<string,unknown>>(`SELECT *,updated_at::text AS updated_at_text FROM public.adv_payment_promises WHERE id=$1::uuid FOR UPDATE`,[params.id]);const row=current.rows[0];if(!row)throw new HttpError(404,"PAYMENT_PROMISE_NOT_FOUND","Promesse introuvable.");if(String(row.status)!=="OPEN")throw new HttpError(409,"PAYMENT_PROMISE_CLOSED","La promesse est déjà clôturée.");if(String(row.updated_at_text)!==params.input.expected_updated_at)throw new HttpError(409,"CONCURRENT_MODIFICATION","La promesse a changé. Rechargez la file.");const updated=await tx.query<Record<string,unknown>>(`UPDATE public.adv_payment_promises SET status=$2,resolution_note=$3,resolved_at=now(),resolved_by=$4,updated_at=now(),updated_by=$4,version=version+1 WHERE id=$1::uuid RETURNING id::text,status,updated_at::text`,[params.id,params.input.status,params.input.resolution_note,params.actor.user_id]);const response={promise:updated.rows[0],idempotent_replay:false};await appendCaseEvent(tx,{caseType:"PAYMENT_PROMISE",caseId:params.id,eventType:params.input.status,actorId:params.actor.user_id,snapshot:{resolution_note:params.input.resolution_note}});await insertAudit(tx,params.actor,{action:"adv.payment_promise.status_changed",entity_type:"facture",entity_id:String(row.facture_id),details:{promise_id:params.id,status:params.input.status}});await saveReceipt(tx,"PAYMENT_PROMISE_STATUS",params.idempotencyKey,hash,params.actor.user_id,response);return response;});}

export async function repoCreateInvoiceDispute(params:{invoiceId:number;input:InvoiceDisputeBodyDTO;actor:AdvActor;idempotencyKey:string}){return inTransaction(async(tx)=>{await ensureInstalled(tx);const hash=advPayloadHash({invoice_id:params.invoiceId,...params.input});const replay=await readReceipt<Record<string,unknown>>(tx,"INVOICE_DISPUTE_CREATE",params.idempotencyKey,hash);if(replay)return replay;const invoice=await invoiceIdentity(tx,params.invoiceId);if(params.input.disputed_amount_ttc&&moneyToCents(params.input.disputed_amount_ttc)>moneyToCents(String(invoice.balance_ttc)))throw new HttpError(422,"DISPUTE_EXCEEDS_BALANCE","Le montant litigieux dépasse le solde restant.");const inserted=await tx.query<Record<string,unknown>>(`INSERT INTO public.adv_invoice_disputes(facture_id,category,disputed_amount_ttc,owner_user_id,next_action,due_date,detail,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id::text,status,created_at::text,updated_at::text`,[params.invoiceId,params.input.category,params.input.disputed_amount_ttc??null,params.input.owner_user_id,params.input.next_action,params.input.due_date,params.input.detail,params.actor.user_id]);const response={dispute:inserted.rows[0],idempotent_replay:false};await appendCaseEvent(tx,{caseType:"INVOICE_DISPUTE",caseId:String(inserted.rows[0]?.id),eventType:"OPENED",actorId:params.actor.user_id,snapshot:{invoice_id:params.invoiceId,...params.input}});await insertAudit(tx,params.actor,{action:"adv.invoice_dispute.opened",entity_type:"facture",entity_id:String(params.invoiceId),details:{dispute_id:inserted.rows[0]?.id,category:params.input.category,disputed_amount_ttc:params.input.disputed_amount_ttc??null}});await saveReceipt(tx,"INVOICE_DISPUTE_CREATE",params.idempotencyKey,hash,params.actor.user_id,response);return response;});}

export async function repoUpdateInvoiceDispute(params:{id:string;input:InvoiceDisputeStatusBodyDTO;actor:AdvActor;idempotencyKey:string}){return inTransaction(async(tx)=>{await ensureInstalled(tx);const hash=advPayloadHash({id:params.id,...params.input});const replay=await readReceipt<Record<string,unknown>>(tx,"INVOICE_DISPUTE_STATUS",params.idempotencyKey,hash);if(replay)return replay;const current=await tx.query<Record<string,unknown>>(`SELECT *,updated_at::text AS updated_at_text FROM public.adv_invoice_disputes WHERE id=$1::uuid FOR UPDATE`,[params.id]);const row=current.rows[0];if(!row)throw new HttpError(404,"INVOICE_DISPUTE_NOT_FOUND","Litige introuvable.");if(String(row.status)!=="OPEN")throw new HttpError(409,"INVOICE_DISPUTE_CLOSED","Le litige est déjà clôturé.");if(String(row.updated_at_text)!==params.input.expected_updated_at)throw new HttpError(409,"CONCURRENT_MODIFICATION","Le litige a changé. Rechargez la file.");const updated=await tx.query<Record<string,unknown>>(`UPDATE public.adv_invoice_disputes SET status=$2,resolution_note=$3,resolved_at=now(),resolved_by=$4,updated_at=now(),updated_by=$4,version=version+1 WHERE id=$1::uuid RETURNING id::text,status,updated_at::text`,[params.id,params.input.status,params.input.resolution_note,params.actor.user_id]);const response={dispute:updated.rows[0],idempotent_replay:false};await appendCaseEvent(tx,{caseType:"INVOICE_DISPUTE",caseId:params.id,eventType:params.input.status,actorId:params.actor.user_id,snapshot:{resolution_note:params.input.resolution_note}});await insertAudit(tx,params.actor,{action:"adv.invoice_dispute.status_changed",entity_type:"facture",entity_id:String(row.facture_id),details:{dispute_id:params.id,status:params.input.status}});await saveReceipt(tx,"INVOICE_DISPUTE_STATUS",params.idempotencyKey,hash,params.actor.user_id,response);return response;});}
