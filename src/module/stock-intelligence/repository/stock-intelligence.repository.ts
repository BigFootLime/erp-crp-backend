import crypto from "node:crypto";
import type { PoolClient } from "pg";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import { normalizeUnit } from "../../commande-fournisseur/domain/replenishment-calculation";
import {
  STOCK_INTELLIGENCE_CONTRACT_VERSION,
  STOCK_INTELLIGENCE_DEFAULT_POLICY,
  STOCK_INTELLIGENCE_TIMEZONE,
  buildStockProjection,
  classifyAbc,
  historicalCoverageWeeks,
  inventoryAccuracy,
  roundStockMetric,
  roundStockQty,
  stockTurnoverPerYear,
  summarizeStockValues,
  type DatedQuantity,
  type StockIntelligencePolicy,
  type StockReliability,
} from "../domain/stock-intelligence";
import type {
  StockIntelligenceOverviewQueryDTO,
  StockIntelligencePolicyBodyDTO,
  StockIntelligenceSimulationBodyDTO,
} from "../validators/stock-intelligence.validators";

type Queryer = Pick<PoolClient, "query">;

export type StockIntelligenceActor = {
  user_id: number;
  role: string | null;
  ip: string | null;
  user_agent: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

type ScopeRow = {
  key: string;
  article_id: string;
  article_code: string;
  article_designation: string;
  magasin_id: string | null;
  magasin_name: string | null;
  stock_unit: string | null;
  qty_on_hand: number;
  qty_reserved: number;
  qty_quarantine: number;
  qty_blocked: number;
  qty_depreciated: number;
  qty_available: number;
  freshness_at: string;
};

type MovementEvidenceRow = {
  key: string;
  outbound_qty_abc: number;
  outbound_value_abc: number | null;
  outbound_qty_coverage: number;
  last_outbound_at: string | null;
  latest_applied_unit_cost: number | null;
  cost_currency: string | null;
  unpriced_movement_count: number;
  currency_count: number;
  freshness_at: string | null;
};

type ReservationRow = {
  key: string;
  reservation_id: string;
  qty: number;
  need_date: string | null;
  of_id: string | null;
  of_number: string | null;
  source_type: string;
  updated_at: string;
};

type ReceiptRow = {
  key: string;
  order_code: string;
  line_id: string;
  remaining_purchase_qty: number;
  purchase_unit: string | null;
  line_stock_unit: string | null;
  conversion_factor: number | null;
  promised_date: string | null;
  lead_time_date: string | null;
  updated_at: string;
};

type InventoryRow = {
  key: string;
  theoretical_qty: number | null;
  counted_qty: number | null;
  counted_at: string | null;
};

type ProposalRow = {
  key: string;
  proposal_id: string;
  status: string;
  reason_code: string;
  net_requirement_qty: number;
  proposed_stock_qty: number | null;
  proposed_purchase_qty: number | null;
  missing_data: string[];
  warnings: string[];
  last_recalculated_at: string;
};

type Metric<T = number> = {
  value: T | null;
  definition: string;
  unit: string;
  period: { from: string; to: string; as_of: string };
  source: string[];
  freshness_at: string | null;
  reliability: StockReliability;
  missing: string[];
};

const DAY_MS = 86_400_000;
const dateOnly = (value = new Date()) => value.toISOString().slice(0, 10);
const subtractDays = (date: string, days: number) => dateOnly(new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS));

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredNumber(value: unknown, field: string): number {
  const parsed = numberOrNull(value);
  if (parsed === null) throw new HttpError(500, "STOCK_SOURCE_DATA_INVALID", `La donnée source ${field} est absente ou invalide.`);
  return parsed;
}

function maxTimestamp(values: Array<string | null | undefined>): string | null {
  return values
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
    .join(",")}}`;
}

function requestHash(value: unknown): string {
  return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex");
}

async function ensureInstalled(queryer: Queryer = db): Promise<void> {
  const result = await queryer.query<{ installed: boolean }>(
    `SELECT to_regclass('public.stock_intelligence_policy_versions') IS NOT NULL
         AND to_regclass('public.stock_intelligence_command_receipts') IS NOT NULL
         AND to_regclass('public.v_stock_availability_225') IS NOT NULL AS installed`,
  );
  if (!result.rows[0]?.installed) {
    throw new HttpError(503, "STOCK_INTELLIGENCE_NOT_INSTALLED", "Le patch SOL-19 doit être appliqué avant d'utiliser la couverture stock.");
  }
}

async function loadPolicy(asOf: string, queryer: Queryer = db): Promise<StockIntelligencePolicy> {
  const result = await queryer.query(
    `SELECT id::text,valid_from::text,abc_lookback_days,
            abc_a_cumulative_pct::float8,abc_b_cumulative_pct::float8,
            dormant_after_days,consumption_lookback_days,coverage_weeks,
            inventory_tolerance_pct::float8,inventory_absolute_tolerance_qty::float8
       FROM public.stock_intelligence_policy_versions
      WHERE valid_from <= $1::date
      ORDER BY valid_from DESC,created_at DESC LIMIT 1`,
    [asOf],
  );
  const row = result.rows[0];
  if (!row) return { ...STOCK_INTELLIGENCE_DEFAULT_POLICY };
  return {
    id: row.id,
    valid_from: row.valid_from,
    abc_lookback_days: Number(row.abc_lookback_days),
    abc_a_cumulative_pct: Number(row.abc_a_cumulative_pct),
    abc_b_cumulative_pct: Number(row.abc_b_cumulative_pct),
    dormant_after_days: Number(row.dormant_after_days),
    consumption_lookback_days: Number(row.consumption_lookback_days),
    coverage_weeks: Number(row.coverage_weeks),
    inventory_tolerance_pct: Number(row.inventory_tolerance_pct),
    inventory_absolute_tolerance_qty: Number(row.inventory_absolute_tolerance_qty),
    source: "VERSIONED_POLICY",
  };
}

async function loadScopes(query: StockIntelligenceOverviewQueryDTO, queryer: Queryer): Promise<ScopeRow[]> {
  const result = await queryer.query(
    `SELECT concat(sl.article_id::text,':',COALESCE(m.id::text,'-')) AS key,
            sl.article_id::text,a.code AS article_code,a.designation AS article_designation,
            m.id::text AS magasin_id,COALESCE(m.name,m.libelle,m.code_magasin)::text AS magasin_name,
            CASE WHEN count(DISTINCT lower(btrim(COALESCE(u.code::text,a.unite)))) = 1
                 THEN min(COALESCE(u.code::text,a.unite)) ELSE NULL END::text AS stock_unit,
            sum(v.qty_on_hand)::float8 AS qty_on_hand,
            sum(v.qty_reserved)::float8 AS qty_reserved,
            sum(v.qty_quarantine)::float8 AS qty_quarantine,
            sum(v.qty_blocked)::float8 AS qty_blocked,
            sum(v.qty_depreciated)::float8 AS qty_depreciated,
            sum(v.qty_available)::float8 AS qty_available,
            max(v.updated_at)::text AS freshness_at
       FROM public.stock_levels sl
       JOIN public.articles a ON a.id=sl.article_id
       JOIN public.v_stock_availability_225 v ON v.stock_level_id=sl.id
       LEFT JOIN public.units u ON u.id=sl.unit_id
       LEFT JOIN public.emplacements e ON e.location_id=sl.location_id
       LEFT JOIN public.magasins m ON m.id=e.magasin_id
      WHERE sl.managed_in_stock IS TRUE
        AND ($1::uuid IS NULL OR sl.article_id=$1::uuid)
        AND ($2::uuid IS NULL OR m.id=$2::uuid)
      GROUP BY sl.article_id,a.code,a.designation,m.id,m.name,m.libelle,m.code_magasin
      ORDER BY a.code,magasin_name NULLS LAST
      LIMIT $3`,
    [query.article_id ?? null, query.magasin_id ?? null, query.limit],
  );
  return result.rows.map((row) => ({
    key: row.key,
    article_id: row.article_id,
    article_code: row.article_code,
    article_designation: row.article_designation,
    magasin_id: row.magasin_id ?? null,
    magasin_name: row.magasin_name ?? null,
    stock_unit: row.stock_unit ?? null,
    qty_on_hand: requiredNumber(row.qty_on_hand, "stock.qty_on_hand"),
    qty_reserved: requiredNumber(row.qty_reserved, "stock.qty_reserved"),
    qty_quarantine: requiredNumber(row.qty_quarantine, "stock.qty_quarantine"),
    qty_blocked: requiredNumber(row.qty_blocked, "stock.qty_blocked"),
    qty_depreciated: requiredNumber(row.qty_depreciated, "stock.qty_depreciated"),
    qty_available: requiredNumber(row.qty_available, "stock.qty_available"),
    freshness_at: row.freshness_at,
  }));
}

async function loadMovementEvidence(
  query: StockIntelligenceOverviewQueryDTO,
  policy: StockIntelligencePolicy,
  asOf: string,
  queryer: Queryer,
) {
  const result = await queryer.query(
    `WITH movement_cost AS (
       SELECT movement.id,movement.article_id,movement.stock_level_id,movement.movement_type::text AS movement_type,
              movement.effective_at,movement.updated_at,movement.doc_type,
              movement.qty::float8 AS movement_qty,
              CASE WHEN count(line.id)>0 AND count(line.unit_cost)=count(line.id)
                    AND count(DISTINCT COALESCE(line.currency,'EUR'))=1
                   THEN sum(abs(line.qty)*line.unit_cost)::float8 ELSE NULL END AS movement_value,
              CASE WHEN count(line.id)>0 AND count(line.unit_cost)=count(line.id)
                   THEN (sum(abs(line.qty)*line.unit_cost)/NULLIF(sum(abs(line.qty)),0))::float8 ELSE NULL END AS unit_cost,
              CASE WHEN count(DISTINCT COALESCE(line.currency,'EUR'))=1
                   THEN min(COALESCE(line.currency,'EUR')) ELSE NULL END AS currency,
              count(DISTINCT COALESCE(line.currency,'EUR'))::int AS currency_count
         FROM public.stock_movements movement
         LEFT JOIN public.stock_movement_lines line ON line.movement_id=movement.id
        WHERE movement.status::text='POSTED' AND movement.effective_at::date <= $1::date
        GROUP BY movement.id
     ), scoped AS (
       SELECT concat(cost.article_id::text,':',COALESCE(magasin.id::text,'-')) AS key,cost.*
         FROM movement_cost cost
         JOIN public.stock_levels level ON level.id=cost.stock_level_id
         LEFT JOIN public.emplacements emplacement ON emplacement.location_id=level.location_id
         LEFT JOIN public.magasins magasin ON magasin.id=emplacement.magasin_id
        WHERE ($4::uuid IS NULL OR cost.article_id=$4::uuid)
          AND ($5::uuid IS NULL OR magasin.id=$5::uuid)
          AND COALESCE(cost.doc_type,'') <> 'STOCK_TRANSFER_INTERNAL'
     )
     SELECT key,
            COALESCE(sum(abs(movement_qty)) FILTER (
              WHERE movement_type IN ('OUT','SCRAP') AND effective_at::date > $1::date-$2::int
            ),0)::float8 AS outbound_qty_abc,
            CASE WHEN count(*) FILTER (
                   WHERE movement_type IN ('OUT','SCRAP') AND effective_at::date > $1::date-$2::int AND movement_value IS NULL
                 )=0 AND count(DISTINCT currency) FILTER (
                   WHERE movement_type IN ('OUT','SCRAP') AND effective_at::date > $1::date-$2::int
                 )<=1
                 THEN COALESCE(sum(movement_value) FILTER (
                   WHERE movement_type IN ('OUT','SCRAP') AND effective_at::date > $1::date-$2::int
                 ),0)::float8 ELSE NULL END AS outbound_value_abc,
            COALESCE(sum(abs(movement_qty)) FILTER (
              WHERE movement_type IN ('OUT','SCRAP') AND effective_at::date > $1::date-$3::int
            ),0)::float8 AS outbound_qty_coverage,
            (max(effective_at) FILTER (WHERE movement_type IN ('OUT','SCRAP')))::text AS last_outbound_at,
            (array_agg(unit_cost ORDER BY effective_at DESC,id DESC) FILTER (WHERE unit_cost IS NOT NULL))[1]::float8 AS latest_applied_unit_cost,
            (array_agg(currency ORDER BY effective_at DESC,id DESC) FILTER (WHERE currency IS NOT NULL))[1]::text AS cost_currency,
            count(*) FILTER (
              WHERE movement_type IN ('OUT','SCRAP') AND effective_at::date > $1::date-$2::int AND movement_value IS NULL
            )::int AS unpriced_movement_count,
            count(DISTINCT currency) FILTER (WHERE unit_cost IS NOT NULL)::int AS currency_count,
            max(updated_at)::text AS freshness_at
       FROM scoped GROUP BY key`,
    [asOf, policy.abc_lookback_days, policy.consumption_lookback_days, query.article_id ?? null, query.magasin_id ?? null],
  );
  return new Map<string, MovementEvidenceRow>(result.rows.map((row) => [row.key, {
    key: row.key,
    outbound_qty_abc: requiredNumber(row.outbound_qty_abc, "movements.outbound_qty_abc"),
    outbound_value_abc: numberOrNull(row.outbound_value_abc),
    outbound_qty_coverage: requiredNumber(row.outbound_qty_coverage, "movements.outbound_qty_coverage"),
    last_outbound_at: row.last_outbound_at ?? null,
    latest_applied_unit_cost: numberOrNull(row.latest_applied_unit_cost),
    cost_currency: row.cost_currency ?? null,
    unpriced_movement_count: Number(row.unpriced_movement_count ?? 0),
    currency_count: Number(row.currency_count ?? 0),
    freshness_at: row.freshness_at ?? null,
  }]));
}

async function loadReservations(query: StockIntelligenceOverviewQueryDTO, queryer: Queryer): Promise<Map<string, ReservationRow[]>> {
  const result = await queryer.query(
    `SELECT concat(reservation.article_id::text,':',COALESCE(magasin.id::text,'-')) AS key,
            reservation.id::text AS reservation_id,reservation.qty_reserved::float8 AS qty,
            COALESCE(fabrication.date_lancement_prevue,reservation.expires_at::date)::text AS need_date,
            reservation.of_id::text,fabrication.numero AS of_number,reservation.source_type,reservation.updated_at::text
       FROM public.stock_reservations reservation
       LEFT JOIN public.ordres_fabrication fabrication ON fabrication.id=reservation.of_id
       LEFT JOIN public.emplacements emplacement ON emplacement.location_id=reservation.location_id
       LEFT JOIN public.magasins magasin ON magasin.id=emplacement.magasin_id
      WHERE reservation.status='ACTIVE'
        AND ($1::uuid IS NULL OR reservation.article_id=$1::uuid)
        AND ($2::uuid IS NULL OR magasin.id=$2::uuid)`,
    [query.article_id ?? null, query.magasin_id ?? null],
  );
  const grouped = new Map<string, ReservationRow[]>();
  for (const row of result.rows) {
    const item: ReservationRow = {
      key: row.key,
      reservation_id: row.reservation_id,
      qty: requiredNumber(row.qty, "reservation.qty"),
      need_date: row.need_date ?? null,
      of_id: row.of_id ?? null,
      of_number: row.of_number ?? null,
      source_type: row.source_type,
      updated_at: row.updated_at,
    };
    grouped.set(item.key, [...(grouped.get(item.key) ?? []), item]);
  }
  return grouped;
}

async function loadReceipts(query: StockIntelligenceOverviewQueryDTO, queryer: Queryer): Promise<Map<string, ReceiptRow[]>> {
  const result = await queryer.query(
    `SELECT concat(line.article_id::text,':',COALESCE(magasin.id::text,'-')) AS key,
            header.code AS order_code,line.id::text AS line_id,
            GREATEST(line.quantite-line.qty_annulee-COALESCE(received.qty,0),0)::float8 AS remaining_purchase_qty,
            line.unite AS purchase_unit,line.unite_stock AS line_stock_unit,line.coef_conversion::float8 AS conversion_factor,
            COALESCE(line.date_promesse,header.date_promesse)::text AS promised_date,
            CASE WHEN COALESCE(line.date_promesse,header.date_promesse) IS NULL
                       AND line.delai_jours IS NOT NULL AND header.date_envoi IS NOT NULL
                 THEN (header.date_envoi::date+line.delai_jours)::text ELSE NULL END AS lead_time_date,
            greatest(line.updated_at,header.updated_at)::text AS updated_at
       FROM public.commande_fournisseur_ligne line
       JOIN public.commande_fournisseur header ON header.id=line.commande_id
       LEFT JOIN public.magasins magasin ON magasin.id=COALESCE(line.magasin_id,header.magasin_livraison_id)
       LEFT JOIN LATERAL (
         SELECT sum(receipt_line.qty_received) AS qty
           FROM public.reception_fournisseur_lignes receipt_line
          WHERE receipt_line.commande_fournisseur_ligne_id=line.id
       ) received ON TRUE
      WHERE line.article_id IS NOT NULL AND line.statut_ligne='ACTIVE'
        AND header.statut IN ('APPROUVEE','ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE')
        AND GREATEST(line.quantite-line.qty_annulee-COALESCE(received.qty,0),0)>0
        AND ($1::uuid IS NULL OR line.article_id=$1::uuid)
        AND ($2::uuid IS NULL OR magasin.id=$2::uuid)`,
    [query.article_id ?? null, query.magasin_id ?? null],
  );
  const grouped = new Map<string, ReceiptRow[]>();
  for (const row of result.rows) {
    const item: ReceiptRow = {
      key: row.key,
      order_code: row.order_code,
      line_id: row.line_id,
      remaining_purchase_qty: requiredNumber(row.remaining_purchase_qty, "supplier_order.remaining_qty"),
      purchase_unit: row.purchase_unit ?? null,
      line_stock_unit: row.line_stock_unit ?? null,
      conversion_factor: numberOrNull(row.conversion_factor),
      promised_date: row.promised_date ?? null,
      lead_time_date: row.lead_time_date ?? null,
      updated_at: row.updated_at,
    };
    grouped.set(item.key, [...(grouped.get(item.key) ?? []), item]);
  }
  return grouped;
}

async function loadInventory(query: StockIntelligenceOverviewQueryDTO, queryer: Queryer): Promise<Map<string, InventoryRow[]>> {
  const result = await queryer.query(
    `WITH latest_count AS (
       SELECT DISTINCT ON (event.snapshot_line_id)
              event.snapshot_line_id,event.counted_qty::float8 AS counted_qty,event.created_at
         FROM public.stock_inventory_count_events event
        ORDER BY event.snapshot_line_id,event.count_round DESC,event.created_at DESC
     ), ranked_snapshot AS (
       SELECT snapshot.*,
              dense_rank() OVER (
                PARTITION BY snapshot.article_id,snapshot.magasin_id
                ORDER BY COALESCE(session.approved_at,session.closed_at,session.updated_at) DESC,session.id DESC
              ) AS session_rank
         FROM public.stock_inventory_snapshot_lines snapshot
         JOIN public.stock_inventory_sessions session ON session.id=snapshot.session_id
        WHERE session.status IN ('APPROVED','CLOSED')
     )
     SELECT concat(snapshot.article_id::text,':',snapshot.magasin_id::text) AS key,
            snapshot.theoretical_qty::float8,latest.counted_qty,latest.created_at::text AS counted_at
       FROM ranked_snapshot snapshot
       LEFT JOIN latest_count latest ON latest.snapshot_line_id=snapshot.id
      WHERE snapshot.session_rank=1
        AND ($1::uuid IS NULL OR snapshot.article_id=$1::uuid)
        AND ($2::uuid IS NULL OR snapshot.magasin_id=$2::uuid)`,
    [query.article_id ?? null, query.magasin_id ?? null],
  );
  const grouped = new Map<string, InventoryRow[]>();
  for (const row of result.rows) {
    const item: InventoryRow = {
      key: row.key,
      theoretical_qty: numberOrNull(row.theoretical_qty),
      counted_qty: numberOrNull(row.counted_qty),
      counted_at: row.counted_at ?? null,
    };
    grouped.set(item.key, [...(grouped.get(item.key) ?? []), item]);
  }
  return grouped;
}

async function loadProposals(query: StockIntelligenceOverviewQueryDTO, queryer: Queryer): Promise<Map<string, ProposalRow>> {
  const result = await queryer.query(
    `SELECT concat(proposal.article_id::text,':',COALESCE(proposal.magasin_id::text,'-')) AS key,
            proposal.id::text AS proposal_id,proposal.status,proposal.reason_code,
            proposal.net_requirement_qty::float8,proposal.proposed_stock_qty::float8,
            proposal.proposed_purchase_qty::float8,proposal.missing_data,proposal.warnings,
            proposal.last_recalculated_at::text
       FROM public.replenishment_proposals proposal
      WHERE ($1::uuid IS NULL OR proposal.article_id=$1::uuid)
        AND ($2::uuid IS NULL OR proposal.magasin_id=$2::uuid)`,
    [query.article_id ?? null, query.magasin_id ?? null],
  );
  return new Map<string, ProposalRow>(result.rows.map((row) => [row.key, {
    key: row.key,
    proposal_id: row.proposal_id,
    status: row.status,
    reason_code: row.reason_code,
    net_requirement_qty: requiredNumber(row.net_requirement_qty, "proposal.net_requirement_qty"),
    proposed_stock_qty: numberOrNull(row.proposed_stock_qty),
    proposed_purchase_qty: numberOrNull(row.proposed_purchase_qty),
    missing_data: Array.isArray(row.missing_data) ? row.missing_data : [],
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    last_recalculated_at: row.last_recalculated_at,
  }]));
}

function metric<T>(input: Metric<T>): Metric<T> {
  return input;
}

async function buildOverview(query: StockIntelligenceOverviewQueryDTO, includeCosts: boolean) {
  const asOf = query.as_of ?? dateOnly();
  const client = await db.connect();
  const evidence = await (async () => {
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await ensureInstalled(client);
      const policy = await loadPolicy(asOf, client);
      const effectiveWeeks = Math.min(query.weeks, policy.coverage_weeks);
      const normalizedQuery = { ...query, weeks: effectiveWeeks };
      const scopes = await loadScopes(normalizedQuery, client);
      const movements = await loadMovementEvidence(normalizedQuery, policy, asOf, client);
      const reservations = await loadReservations(normalizedQuery, client);
      const receipts = await loadReceipts(normalizedQuery, client);
      const inventories = await loadInventory(normalizedQuery, client);
      const proposals = await loadProposals(normalizedQuery, client);
      await client.query("COMMIT");
      return { policy, effectiveWeeks, scopes, movements, reservations, receipts, inventories, proposals };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })();
  const { policy, effectiveWeeks, scopes, movements, reservations, receipts, inventories, proposals } = evidence;
  const abc = new Map(classifyAbc([...movements.entries()].map(([key, movement]) => ({
    key,
    consumption_value: includeCosts ? movement.outbound_value_abc : null,
  })), policy.abc_a_cumulative_pct, policy.abc_b_cumulative_pct).map((item) => [item.key, item]));

  const items = scopes.map((scope) => {
    const movement = movements.get(scope.key);
    const scopeReservations = reservations.get(scope.key) ?? [];
    const scopeReceipts = receipts.get(scope.key) ?? [];
    const scopeInventory = inventories.get(scope.key) ?? [];
    const proposal = proposals.get(scope.key) ?? null;
    const missing = new Set<string>();
    if (!scope.stock_unit) missing.add("STOCK_UNIT_CONFLICT_OR_MISSING");
    const usablePhysical = roundStockQty(scope.qty_on_hand - scope.qty_quarantine - scope.qty_blocked - scope.qty_depreciated);

    const demands: DatedQuantity[] = scopeReservations.map((reservation) => {
      if (!reservation.need_date) missing.add(reservation.of_id ? "OF_NEED_DATE" : "RESERVATION_NEED_DATE");
      return {
        date: reservation.need_date ?? asOf,
        quantity: reservation.qty,
        source: reservation.of_number ? `OF ${reservation.of_number}` : `Réservation ${reservation.source_type}`,
        reference: reservation.of_id ?? reservation.reservation_id,
      };
    });
    const detailedReserved = roundStockQty(scopeReservations.reduce((sum, reservation) => sum + reservation.qty, 0));
    if (Math.abs(detailedReserved - scope.qty_reserved) > 0.001) {
      missing.add("RESERVATION_LEDGER_MISMATCH");
      if (scope.qty_reserved > detailedReserved) {
        demands.push({
          date: asOf,
          quantity: roundStockQty(scope.qty_reserved - detailedReserved),
          source: "Solde réservé non daté",
          reference: null,
        });
      }
    }

    const expectedReceipts: DatedQuantity[] = [];
    for (const receipt of scopeReceipts) {
      const stockUnit = normalizeUnit(scope.stock_unit);
      const purchaseUnit = normalizeUnit(receipt.purchase_unit);
      const declaredStockUnit = normalizeUnit(receipt.line_stock_unit);
      const factor = stockUnit && purchaseUnit && stockUnit === purchaseUnit
        ? 1
        : stockUnit && declaredStockUnit === stockUnit && receipt.conversion_factor && receipt.conversion_factor > 0
          ? receipt.conversion_factor
          : null;
      if (factor === null) {
        missing.add("OPEN_ORDER_UNIT_CONVERSION");
        continue;
      }
      const expectedDate = receipt.promised_date ?? receipt.lead_time_date;
      if (!expectedDate) {
        missing.add("EXPECTED_RECEIPT_DATE");
        continue;
      }
      if (!receipt.promised_date) missing.add("RECEIPT_DATE_FROM_LEAD_TIME");
      expectedReceipts.push({
        date: expectedDate,
        quantity: roundStockQty(receipt.remaining_purchase_qty * factor),
        source: receipt.promised_date ? `Commande ${receipt.order_code}` : `Commande ${receipt.order_code} (délai fournisseur)`,
        reference: receipt.line_id,
      });
    }

    const projection = buildStockProjection({
      as_of: asOf,
      weeks: effectiveWeeks,
      initial_usable_qty: usablePhysical,
      demands,
      receipts: expectedReceipts,
      missing: [...missing],
    });
    const inventory = inventoryAccuracy({
      lines: scopeInventory,
      tolerance_pct: policy.inventory_tolerance_pct,
      absolute_tolerance_qty: policy.inventory_absolute_tolerance_qty,
    });
    const freshness = maxTimestamp([
      scope.freshness_at,
      movement?.freshness_at,
      ...scopeReservations.map((row) => row.updated_at),
      ...scopeReceipts.map((row) => row.updated_at),
      ...scopeInventory.map((row) => row.counted_at),
    ]);
    const stockValueMissing = [] as string[];
    if (!includeCosts) stockValueMissing.push("COST_PERMISSION_REQUIRED");
    if (movement?.latest_applied_unit_cost == null) stockValueMissing.push("CUMP_UNIT_COST_EVIDENCE");
    if ((movement?.currency_count ?? 0) > 1) stockValueMissing.push("COST_CURRENCY_CONFLICT");
    const stockValue = includeCosts && movement?.latest_applied_unit_cost != null && (movement.currency_count ?? 0) <= 1
      ? roundStockMetric((scope.qty_on_hand - scope.qty_depreciated) * movement.latest_applied_unit_cost, 2)
      : null;
    const lastOutboundDays = movement?.last_outbound_at
      ? Math.floor((Date.parse(`${asOf}T23:59:59Z`) - Date.parse(movement.last_outbound_at)) / DAY_MS)
      : null;
    const dormant = scope.qty_on_hand > 0
      ? lastOutboundDays === null || lastOutboundDays >= policy.dormant_after_days
      : false;
    const abcValue = abc.get(scope.key);

    return {
      key: scope.key,
      article_id: scope.article_id,
      article_code: scope.article_code,
      article_designation: scope.article_designation,
      magasin_id: scope.magasin_id,
      magasin_name: scope.magasin_name,
      stock_unit: scope.stock_unit,
      quantities: {
        physical: scope.qty_on_hand,
        reserved: scope.qty_reserved,
        available: scope.qty_available,
        quarantine: scope.qty_quarantine,
        blocked: scope.qty_blocked,
        depreciated: scope.qty_depreciated,
        usable_before_future_demand: usablePhysical,
      },
      stock_value: metric({
        value: stockValue,
        definition: "Quantité physique hors dépréciation × dernier coût unitaire CUMP appliqué et traçable. Ce n'est pas une couche de valorisation par lot.",
        unit: movement?.cost_currency ?? "EUR",
        period: { from: asOf, to: asOf, as_of: asOf },
        source: ["v_stock_availability_225", "stock_movements", "stock_movement_lines", "erp_settings:stock.valuation_method=WEIGHTED_AVERAGE"],
        freshness_at: freshness,
        reliability: stockValue === null ? "UNAVAILABLE" : "ESTIMATED",
        missing: stockValue === null ? stockValueMissing : ["COST_LAYER_NOT_MATERIALIZED"],
      }),
      turnover: metric({
        value: stockTurnoverPerYear({
          outbound_qty: movement?.outbound_qty_abc ?? null,
          current_usable_qty: usablePhysical,
          lookback_days: policy.abc_lookback_days,
        }),
        definition: "Sorties de stock annualisées ÷ stock physique actuellement utilisable.",
        unit: "rotations/an",
        period: { from: subtractDays(asOf, policy.abc_lookback_days), to: asOf, as_of: asOf },
        source: ["stock_movements", "v_stock_availability_225"],
        freshness_at: freshness,
        reliability: movement ? "ACTUAL" : "UNAVAILABLE",
        missing: movement ? [] : ["POSTED_OUTBOUND_MOVEMENTS"],
      }),
      historical_coverage: metric({
        value: historicalCoverageWeeks({
          current_available_qty: scope.qty_available,
          consumed_qty: movement?.outbound_qty_coverage ?? 0,
          lookback_days: policy.consumption_lookback_days,
        }),
        definition: "Stock disponible ÷ consommation hebdomadaire moyenne observée sur la période.",
        unit: "semaines",
        period: { from: subtractDays(asOf, policy.consumption_lookback_days), to: asOf, as_of: asOf },
        source: ["v_stock_availability_225", "stock_movements"],
        freshness_at: freshness,
        reliability: movement?.outbound_qty_coverage ? "ACTUAL" : "UNAVAILABLE",
        missing: movement?.outbound_qty_coverage ? [] : ["HISTORICAL_CONSUMPTION"],
      }),
      dormant: metric<boolean>({
        value: dormant,
        definition: `Stock physique positif sans sortie comptabilisée depuis ${policy.dormant_after_days} jours.`,
        unit: "booléen",
        period: { from: subtractDays(asOf, policy.dormant_after_days), to: asOf, as_of: asOf },
        source: ["stock_movements", "v_stock_availability_225"],
        freshness_at: freshness,
        reliability: scope.qty_on_hand <= 0 || movement?.last_outbound_at ? "ACTUAL" : "PARTIAL",
        missing: movement?.last_outbound_at ? [] : ["NO_OUTBOUND_HISTORY"],
      }),
      inventory_accuracy: metric({
        value: inventory.value,
        definition: `Lignes du dernier historique d'inventaire dans la tolérance max(${policy.inventory_absolute_tolerance_qty}, théorique × ${policy.inventory_tolerance_pct} %).`,
        unit: "% de lignes",
        period: { from: subtractDays(asOf, policy.abc_lookback_days), to: asOf, as_of: asOf },
        source: ["stock_inventory_snapshot_lines", "stock_inventory_count_events"],
        freshness_at: maxTimestamp(scopeInventory.map((row) => row.counted_at)),
        reliability: inventory.value === null ? "UNAVAILABLE" : inventory.missing_lines ? "PARTIAL" : "ACTUAL",
        missing: inventory.value === null ? ["APPROVED_INVENTORY_COUNTS"] : inventory.missing_lines ? ["INVENTORY_COUNT_LINES"] : [],
      }),
      abc: {
        classification: includeCosts ? abcValue?.classification ?? null : null,
        cumulative_pct: includeCosts ? abcValue?.cumulative_pct ?? null : null,
        definition: `Valeur des sorties CUMP sur ${policy.abc_lookback_days} jours, triée décroissante; A jusqu'à ${policy.abc_a_cumulative_pct} %, B jusqu'à ${policy.abc_b_cumulative_pct} %, C au-delà.`,
        unit: "classe",
        period: { from: subtractDays(asOf, policy.abc_lookback_days), to: asOf, as_of: asOf },
        source: ["stock_movements", "stock_movement_lines"],
        freshness_at: movement?.freshness_at ?? null,
        reliability: !includeCosts || abcValue?.classification == null ? "UNAVAILABLE" : movement?.unpriced_movement_count ? "PARTIAL" : "ACTUAL",
        missing: !includeCosts ? ["COST_PERMISSION_REQUIRED"] : abcValue?.classification == null ? ["PRICED_OUTBOUND_MOVEMENTS"] : movement?.unpriced_movement_count ? ["UNPRICED_MOVEMENTS"] : [],
      },
      predicted_shortage_date: projection.shortage_without_proposal,
      projection,
      projection_inputs: {
        initial_usable_qty: usablePhysical,
        demands,
        expected_receipts: expectedReceipts,
      },
      replenishment: proposal ? {
        id: proposal.proposal_id,
        status: proposal.status,
        reason_code: proposal.reason_code,
        need_qty: proposal.net_requirement_qty,
        proposed_stock_qty: proposal.proposed_stock_qty,
        proposed_purchase_qty: proposal.proposed_purchase_qty,
        explanation: "max(0, cible − disponible − réceptions ouvertes), puis MOQ et lot d'achat; la projection 13 semaines expose séparément les OF et réceptions datés.",
        missing: proposal.missing_data,
        warnings: proposal.warnings,
        freshness_at: proposal.last_recalculated_at,
      } : null,
      freshness_at: freshness,
      reliability: projection.missing.length > 0 ? "PARTIAL" : "ACTUAL",
      missing: projection.missing,
    };
  });

  const stockValueSummary = summarizeStockValues(items.map((item) => ({
    value: item.stock_value.value,
    currency: item.stock_value.unit,
  })));
  const inventoryLines = items.map((item) => item.inventory_accuracy.value).filter((value): value is number => value !== null);
  return {
    contract_version: STOCK_INTELLIGENCE_CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
    timezone: STOCK_INTELLIGENCE_TIMEZONE,
    as_of: asOf,
    horizon_weeks: effectiveWeeks,
    policy,
    summary: {
      stock_value: metric({
        value: stockValueSummary.value,
        definition: "Somme des valeurs article/site calculables; une valeur partielle n'intègre jamais les lignes inconnues comme zéro.",
        unit: stockValueSummary.unit,
        period: { from: asOf, to: asOf, as_of: asOf },
        source: ["items.stock_value"],
        freshness_at: maxTimestamp(items.map((item) => item.freshness_at)),
        reliability: stockValueSummary.reliability,
        missing: stockValueSummary.missing,
      }),
      predicted_shortage_count: items.filter((item) => item.predicted_shortage_date !== null).length,
      dormant_count: items.filter((item) => item.dormant.value === true).length,
      inventory_accuracy_pct: inventoryLines.length
        ? roundStockMetric(inventoryLines.reduce((sum, value) => sum + value, 0) / inventoryLines.length, 2)
        : null,
      item_count: items.length,
    },
    items,
    capabilities: {
      costs_visible: includeCosts,
      of_demand: { available: true, scope: "Réservations OF actives seulement" },
      unreserved_of_demand: { available: false, reason: "OF_MATERIAL_REQUIREMENT_SOURCE_NOT_PERSISTED" },
      supplier_receipts: { available: true, scope: "Commandes approuvées ou envoyées, dates et conversions explicites" },
      valuation_layers: { available: false, reason: "CUMP_COST_LAYER_NOT_MATERIALIZED_PER_LOT" },
    },
  };
}

export function repoStockIntelligenceOverview(query: StockIntelligenceOverviewQueryDTO, includeCosts: boolean) {
  return buildOverview(query, includeCosts);
}

export async function repoSimulateStockIntelligence(input: StockIntelligenceSimulationBodyDTO) {
  const overview = await buildOverview({
    as_of: input.as_of,
    magasin_id: input.magasin_id,
    article_id: input.article_id,
    weeks: input.weeks,
    limit: 1,
  }, false);
  const item = overview.items[0];
  if (!item) throw new HttpError(404, "STOCK_SCOPE_NOT_FOUND", "Aucun stock géré ne correspond à cet article et ce magasin.");
  const baseline = item.projection;
  const projection = buildStockProjection({
    as_of: overview.as_of,
    weeks: overview.horizon_weeks,
    initial_usable_qty: item.quantities.usable_before_future_demand,
    demands: item.projection_inputs.demands,
    receipts: item.projection_inputs.expected_receipts,
    simulated_receipt: {
      date: input.expected_receipt_date,
      quantity: input.proposed_stock_qty,
      source: "PROPOSITION_SIMULÉE",
      reference: null,
    },
    missing: baseline.missing,
  });
  return {
    contract_version: overview.contract_version,
    generated_at: new Date().toISOString(),
    write_performed: false,
    article_id: input.article_id,
    magasin_id: input.magasin_id,
    stock_unit: item.stock_unit,
    proposed_stock_qty: input.proposed_stock_qty,
    expected_receipt_date: input.expected_receipt_date,
    projection,
  };
}

async function insertAudit(tx: Queryer, actor: StockIntelligenceActor, policyId: string, input: StockIntelligencePolicyBodyDTO) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: "stock.intelligence.policy.versioned",
    page_key: actor.page_key,
    entity_type: "stock_intelligence_policy_versions",
    entity_id: policyId,
    path: actor.path,
    client_session_id: actor.client_session_id,
    details: { valid_from: input.valid_from, reason: input.reason, parameters: input },
  };
  await repoInsertAuditLog({
    user_id: actor.user_id,
    body,
    ip: actor.ip,
    user_agent: actor.user_agent,
    device_type: null,
    os: null,
    browser: null,
    tx,
  });
}

export async function repoCreateStockIntelligencePolicy(args: {
  input: StockIntelligencePolicyBodyDTO;
  actor: StockIntelligenceActor;
  idempotencyKey: string;
}) {
  await ensureInstalled();
  const client = await db.connect();
  const hash = requestHash(args.input);
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const replay = await client.query<{ request_hash: string; response_snapshot: Record<string, unknown> }>(
      `SELECT request_hash,response_snapshot FROM public.stock_intelligence_command_receipts
        WHERE idempotency_key=$1 FOR SHARE`,
      [args.idempotencyKey],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== hash) {
        throw new HttpError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "Cette clé d'idempotence a déjà été utilisée avec une politique différente.");
      }
      await client.query("COMMIT");
      return { ...replay.rows[0].response_snapshot, idempotent_replay: true };
    }
    const inserted = await client.query<{ id: string; created_at: string }>(
      `INSERT INTO public.stock_intelligence_policy_versions
        (valid_from,abc_lookback_days,abc_a_cumulative_pct,abc_b_cumulative_pct,
         dormant_after_days,consumption_lookback_days,coverage_weeks,
         inventory_tolerance_pct,inventory_absolute_tolerance_qty,reason,created_by)
       VALUES($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id::text,created_at::text`,
      [args.input.valid_from, args.input.abc_lookback_days, args.input.abc_a_cumulative_pct,
        args.input.abc_b_cumulative_pct, args.input.dormant_after_days, args.input.consumption_lookback_days,
        args.input.coverage_weeks, args.input.inventory_tolerance_pct, args.input.inventory_absolute_tolerance_qty,
        args.input.reason, args.actor.user_id],
    );
    const response = {
      id: inserted.rows[0].id,
      created_at: inserted.rows[0].created_at,
      ...args.input,
      idempotent_replay: false,
    };
    await insertAudit(client, args.actor, response.id, args.input);
    await client.query(
      `INSERT INTO public.stock_intelligence_command_receipts
        (idempotency_key,request_hash,actor_user_id,response_snapshot)
       VALUES($1,$2,$3,$4::jsonb)`,
      [args.idempotencyKey, hash, args.actor.user_id, JSON.stringify(response)],
    );
    await client.query("COMMIT");
    return response;
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string; constraint?: string }).code === "23505") {
      throw new HttpError(409, "STOCK_POLICY_DATE_CONFLICT", "Une politique existe déjà à cette date. Choisissez une nouvelle date d'effet.");
    }
    if ((error as { code?: string }).code === "40001") {
      throw new HttpError(409, "STOCK_POLICY_RETRY", "La politique a changé pendant l'enregistrement. Rechargez puis réessayez.");
    }
    throw error;
  } finally {
    client.release();
  }
}
