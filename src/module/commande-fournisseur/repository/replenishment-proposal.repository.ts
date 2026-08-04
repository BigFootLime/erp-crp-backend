import crypto from "node:crypto"
import type { PoolClient } from "pg"

import db from "../../../config/database"
import { generateCommandeFournisseurCode } from "../../../shared/codes/code-generator.service"
import { HttpError } from "../../../utils/httpError"
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"
import { computeCommandeTotaux } from "../domain/commande-fournisseur-totaux"
import { calculateReplenishment, normalizeUnit } from "../domain/replenishment-calculation"
import type { AuditContext } from "./commande-fournisseur.repository"
import type {
  ReplenishmentProposal,
  ReplenishmentRefreshResult,
  ReplenishmentSupplierCandidate,
} from "../types/replenishment-proposal.types"
import type {
  ListReplenishmentProposalsDTO,
  RefreshReplenishmentProposalsDTO,
  ValidateReplenishmentProposalDTO,
} from "../validators/replenishment-proposal.validators"

type Queryer = Pick<PoolClient, "query">

type StockContext = {
  stock_level_ids: string[]
  stock_level_count: number
  article_id: string
  article_code: string
  article_designation: string
  stock_unit: string | null
  magasin_id: string | null
  magasin_name: string | null
  qty_on_hand: number
  qty_reserved: number
  qty_available: number
  qty_open_orders: number
  open_order_conversion_missing: boolean
  stock_unit_conflict: boolean
  min_qty: number | null
  safety_stock_qty: number | null
  target_stock_qty: number | null
  reorder_qty: number | null
  order_lot_size: number | null
  preferred_catalogue_id: string | null
  preferred_supplier_id: string | null
}

const n = (value: unknown): number => Number(value ?? 0)
const nullableNumber = (value: unknown): number | null => value == null ? null : Number(value)

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`
}

const hashRequest = (value: unknown) => crypto.createHash("sha256").update(stable(value)).digest("hex")

async function audit(tx: Queryer, context: AuditContext, action: string, entityId: string, details: Record<string, unknown>) {
  await repoInsertAuditLog({
    user_id: context.user_id,
    body: {
      event_type: "ACTION",
      action,
      page_key: context.page_key,
      entity_type: "replenishment_proposal",
      entity_id: entityId,
      path: context.path,
      client_session_id: context.client_session_id,
      details,
    },
    ip: context.ip,
    user_agent: context.user_agent,
    device_type: context.device_type,
    os: context.os,
    browser: context.browser,
    tx,
  })
}

async function readStockContexts(
  queryer: Queryer,
  filters: RefreshReplenishmentProposalsDTO & {
    scope?: { article_id: string; magasin_id: string | null }
  }
): Promise<StockContext[]> {
  const values: unknown[] = []
  const where = ["sl.managed_in_stock IS TRUE"]
  const push = (value: unknown) => { values.push(value); return `$${values.length}` }
  if (filters.scope) {
    where.push(`sl.article_id = ${push(filters.scope.article_id)}::uuid`)
    where.push(filters.scope.magasin_id
      ? `m.id = ${push(filters.scope.magasin_id)}::uuid`
      : "m.id IS NULL")
  } else {
    if (filters.magasin_id) where.push(`m.id = ${push(filters.magasin_id)}::uuid`)
    if (filters.article_id) where.push(`sl.article_id = ${push(filters.article_id)}::uuid`)
  }
  values.push(filters.limit)

  const result = await queryer.query(
    `WITH stock_rows AS (
       SELECT
         sl.id, sl.article_id, a.code AS article_code, a.designation AS article_designation,
         COALESCE(u.code::text, a.unite)::text AS stock_unit,
         m.id AS magasin_id, COALESCE(m.name, m.libelle, m.code_magasin)::text AS magasin_name,
         COALESCE(av.qty_on_hand, sl.qty_total, 0)::numeric AS qty_on_hand,
         COALESCE(av.qty_reserved, sl.qty_reserved, 0)::numeric AS qty_reserved,
         COALESCE(av.qty_available, GREATEST(sl.qty_total - sl.qty_reserved, 0), 0)::numeric AS qty_available,
         sl.min_qty, app.min_stock AS profile_min_qty, sl.safety_stock_qty,
         sl.target_stock_qty, app.max_stock AS profile_target_qty,
         sl.reorder_qty, sl.order_lot_size, app.preferred_catalogue_id, sl.supplier_id
       FROM public.stock_levels sl
       JOIN public.articles a ON a.id = sl.article_id
       LEFT JOIN public.units u ON u.id = sl.unit_id
       LEFT JOIN public.emplacements e ON e.location_id = sl.location_id
       LEFT JOIN public.magasins m ON m.id = e.magasin_id
       LEFT JOIN public.article_procurement_profile app ON app.article_id = sl.article_id
       LEFT JOIN LATERAL (
         SELECT SUM(v.qty_on_hand) AS qty_on_hand,
                SUM(v.qty_reserved) AS qty_reserved,
                SUM(v.qty_available) AS qty_available
         FROM public.v_stock_availability_225 v
         WHERE v.stock_level_id = sl.id
       ) av ON TRUE
       WHERE ${where.join(" AND ")}
     ), stock_scopes AS (
       SELECT
         article_id, magasin_id,
         MAX(article_code)::text AS article_code,
         MAX(article_designation)::text AS article_designation,
         array_agg(id::text ORDER BY id::text) AS stock_level_ids,
         COUNT(*)::int AS stock_level_count,
         CASE
           WHEN COUNT(stock_unit) = COUNT(*) AND COUNT(DISTINCT
             CASE WHEN lower(btrim(stock_unit)) IN ('pce','pcs','pc','piece','pièce') THEN 'u' ELSE lower(btrim(stock_unit)) END
           ) = 1
             THEN MIN(stock_unit)
           ELSE NULL
         END::text AS stock_unit,
         (COUNT(stock_unit) <> COUNT(*) OR COUNT(DISTINCT
           CASE WHEN lower(btrim(stock_unit)) IN ('pce','pcs','pc','piece','pièce') THEN 'u' ELSE lower(btrim(stock_unit)) END
         ) > 1) AS stock_unit_conflict,
         MAX(magasin_name)::text AS magasin_name,
         SUM(qty_on_hand)::float8 AS qty_on_hand,
         SUM(qty_reserved)::float8 AS qty_reserved,
         SUM(qty_available)::float8 AS qty_available,
         CASE WHEN COUNT(min_qty) > 0 THEN SUM(COALESCE(min_qty, 0)) ELSE MAX(profile_min_qty) END::float8 AS min_qty,
         CASE WHEN COUNT(safety_stock_qty) > 0 THEN SUM(COALESCE(safety_stock_qty, 0)) ELSE NULL END::float8 AS safety_stock_qty,
         CASE WHEN COUNT(target_stock_qty) > 0 THEN SUM(COALESCE(target_stock_qty, 0)) ELSE MAX(profile_target_qty) END::float8 AS target_stock_qty,
         CASE WHEN COUNT(reorder_qty) > 0 THEN SUM(COALESCE(reorder_qty, 0)) ELSE NULL END::float8 AS reorder_qty,
         MAX(order_lot_size)::float8 AS order_lot_size,
         MAX(preferred_catalogue_id::text) AS preferred_catalogue_id,
         CASE WHEN COUNT(DISTINCT supplier_id) = 1 THEN MIN(supplier_id::text) ELSE NULL END AS preferred_supplier_id
       FROM stock_rows
       GROUP BY article_id, magasin_id
     )
     SELECT scope.*,
            COALESCE(incoming.qty_open_orders_stock, 0)::float8 AS qty_open_orders,
            COALESCE(incoming.conversion_missing, false) AS open_order_conversion_missing
     FROM stock_scopes scope
     LEFT JOIN LATERAL (
       SELECT
         SUM(open_line.remaining_purchase_qty * open_line.stock_units_per_purchase_unit)
           FILTER (WHERE open_line.stock_units_per_purchase_unit IS NOT NULL)::float8 AS qty_open_orders_stock,
         BOOL_OR(open_line.remaining_purchase_qty > 0 AND open_line.stock_units_per_purchase_unit IS NULL) AS conversion_missing
       FROM (
         SELECT
           GREATEST(line.quantite - line.qty_annulee - COALESCE(received.qty, 0), 0) AS remaining_purchase_qty,
           CASE
             WHEN
               (CASE WHEN lower(btrim(COALESCE(line.unite, ''))) IN ('pce','pcs','pc','piece','pièce') THEN 'u' ELSE lower(btrim(COALESCE(line.unite, ''))) END)
               =
               (CASE WHEN lower(btrim(COALESCE(scope.stock_unit, ''))) IN ('pce','pcs','pc','piece','pièce') THEN 'u' ELSE lower(btrim(COALESCE(scope.stock_unit, ''))) END)
               AND btrim(COALESCE(scope.stock_unit, '')) <> ''
               THEN 1::numeric
             WHEN line.coef_conversion > 0
               AND line.unite_stock IS NOT NULL
               AND (CASE WHEN lower(btrim(line.unite_stock)) IN ('pce','pcs','pc','piece','pièce') THEN 'u' ELSE lower(btrim(line.unite_stock)) END)
                 =
                 (CASE WHEN lower(btrim(COALESCE(scope.stock_unit, ''))) IN ('pce','pcs','pc','piece','pièce') THEN 'u' ELSE lower(btrim(COALESCE(scope.stock_unit, ''))) END)
               THEN line.coef_conversion
             ELSE NULL
           END AS stock_units_per_purchase_unit
         FROM public.commande_fournisseur_ligne line
         JOIN public.commande_fournisseur po_header ON po_header.id = line.commande_id
         LEFT JOIN LATERAL (
           SELECT SUM(reception_line.qty_received) AS qty
           FROM public.reception_fournisseur_lignes reception_line
           WHERE reception_line.commande_fournisseur_ligne_id = line.id
         ) received ON TRUE
         WHERE line.article_id = scope.article_id
           AND line.statut_ligne = 'ACTIVE'
           AND po_header.statut IN ('BROUILLON','A_VALIDER','APPROUVEE','ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE')
           AND COALESCE(line.magasin_id, po_header.magasin_livraison_id) IS NOT DISTINCT FROM scope.magasin_id
       ) open_line
     ) incoming ON TRUE
     ORDER BY scope.article_code, scope.magasin_name NULLS LAST
     LIMIT $${values.length}`,
    values
  )
  return result.rows.map((row) => ({
    ...row,
    stock_level_ids: Array.isArray(row.stock_level_ids) ? row.stock_level_ids : [],
    stock_level_count: n(row.stock_level_count),
    qty_on_hand: n(row.qty_on_hand), qty_reserved: n(row.qty_reserved), qty_available: n(row.qty_available),
    qty_open_orders: n(row.qty_open_orders), min_qty: nullableNumber(row.min_qty),
    safety_stock_qty: nullableNumber(row.safety_stock_qty), target_stock_qty: nullableNumber(row.target_stock_qty),
    reorder_qty: nullableNumber(row.reorder_qty), order_lot_size: nullableNumber(row.order_lot_size),
    open_order_conversion_missing: Boolean(row.open_order_conversion_missing),
    stock_unit_conflict: Boolean(row.stock_unit_conflict),
  })) as StockContext[]
}

async function loadCandidates(queryer: Queryer, context: StockContext): Promise<ReplenishmentSupplierCandidate[]> {
  const result = await queryer.query(
    `SELECT fc.id::text AS catalogue_id, f.id::text AS supplier_id,
            COALESCE(f.code, f.code_fournisseur)::text AS supplier_code,
            COALESCE(f.nom, f.raison_sociale)::text AS supplier_name,
            fc.unite AS purchase_unit, COALESCE(fc.unite_stock, $2)::text AS stock_unit,
            fc.coef_conversion::float8 AS stock_units_per_purchase_unit,
            fc.moq::float8 AS moq, COALESCE(fc.lot_achat, $3::numeric)::float8 AS purchase_lot_size,
            fc.delai_jours::int AS lead_time_days, fc.prix_unitaire::float8 AS catalogue_price,
            COALESCE(fc.devise, 'EUR')::text AS currency,
            history.unit_price::float8 AS last_order_unit_price, history.order_date::text AS last_order_date,
            (fc.id = $4::uuid OR f.id = $5::uuid) AS preferred,
            f.actif, f.status
       FROM public.fournisseur_catalogue fc
       JOIN public.fournisseurs f ON f.id = fc.fournisseur_id
       LEFT JOIN LATERAL (
         SELECT line.prix_unitaire_ht AS unit_price, header.created_at::date AS order_date
         FROM public.commande_fournisseur_ligne line
         JOIN public.commande_fournisseur header ON header.id = line.commande_id
         WHERE line.article_id = fc.article_id AND header.fournisseur_id = fc.fournisseur_id
           AND line.statut_ligne = 'ACTIVE' AND header.statut <> 'ANNULEE'
         ORDER BY header.created_at DESC LIMIT 1
       ) history ON TRUE
      WHERE fc.article_id = $1::uuid AND fc.actif IS TRUE
        AND COALESCE(f.actif, true) IS TRUE AND COALESCE(f.status, 'actif') NOT IN ('inactif','archive')
      ORDER BY preferred DESC, fc.prix_unitaire ASC NULLS LAST, supplier_name`,
    [context.article_id, context.stock_unit, context.order_lot_size, context.preferred_catalogue_id, context.preferred_supplier_id]
  )
  return result.rows.map((row) => {
    const stockUnit = normalizeUnit(row.stock_unit)
    const purchaseUnit = normalizeUnit(row.purchase_unit)
    const coefficient = stockUnit && purchaseUnit && stockUnit === purchaseUnit
      ? 1
      : nullableNumber(row.stock_units_per_purchase_unit)
    const blockers: string[] = []
    if (!purchaseUnit) blockers.push("PURCHASE_UNIT")
    if (!stockUnit) blockers.push("STOCK_UNIT")
    if (stockUnit && purchaseUnit && stockUnit !== purchaseUnit && !coefficient) blockers.push("UNIT_CONVERSION")
    const cataloguePrice = nullableNumber(row.catalogue_price)
    const historicalPrice = nullableNumber(row.last_order_unit_price)
    return {
      catalogue_id: row.catalogue_id,
      supplier_id: row.supplier_id,
      supplier_code: row.supplier_code ?? null,
      supplier_name: row.supplier_name,
      purchase_unit: row.purchase_unit ?? null,
      stock_unit: row.stock_unit ?? null,
      stock_units_per_purchase_unit: coefficient,
      moq: nullableNumber(row.moq),
      purchase_lot_size: nullableNumber(row.purchase_lot_size),
      lead_time_days: row.lead_time_days == null ? null : Number(row.lead_time_days),
      unit_price: cataloguePrice ?? historicalPrice,
      currency: row.currency ?? "EUR",
      price_source: cataloguePrice != null ? "CATALOGUE" : historicalPrice != null ? "HISTORICAL" : "MISSING",
      last_order_unit_price: historicalPrice,
      last_order_date: row.last_order_date ?? null,
      preferred: Boolean(row.preferred),
      blockers,
    }
  })
}

async function budgetFor(queryer: Queryer, context: StockContext, candidate: ReplenishmentSupplierCandidate | null, estimate: number | null) {
  if (!context.magasin_id || !candidate || estimate == null) return { status: "MISSING" as const, remaining: null }
  const result = await queryer.query(
    `SELECT budget.amount_limit::float8 AS amount_limit,
            COALESCE(committed.amount, 0)::float8 AS committed
       FROM public.replenishment_budgets budget
       LEFT JOIN LATERAL (
         SELECT SUM(line.quantite * line.prix_unitaire_ht) AS amount
         FROM public.commande_fournisseur_ligne line
         JOIN public.commande_fournisseur header ON header.id = line.commande_id
         WHERE COALESCE(line.magasin_id, header.magasin_livraison_id) = budget.magasin_id
           AND header.devise = budget.currency AND header.created_at::date BETWEEN budget.period_start AND budget.period_end
           AND header.statut <> 'ANNULEE' AND line.statut_ligne = 'ACTIVE'
       ) committed ON TRUE
      WHERE budget.magasin_id = $1::uuid AND budget.currency = $2 AND budget.active
        AND CURRENT_DATE BETWEEN budget.period_start AND budget.period_end
      ORDER BY budget.period_start DESC LIMIT 1`,
    [context.magasin_id, candidate.currency]
  )
  const row = result.rows[0]
  if (!row) return { status: "MISSING" as const, remaining: null }
  const remaining = Math.round((n(row.amount_limit) - n(row.committed)) * 100) / 100
  return { status: estimate > remaining ? "EXCEEDED" as const : "OK" as const, remaining }
}

function addScopeMissingData(
  calculation: ReturnType<typeof calculateReplenishment>,
  context: StockContext,
  hasSupplier: boolean
) {
  if (!context.magasin_id) calculation.missing_data.push("SITE")
  if (context.stock_unit_conflict) calculation.missing_data.push("STOCK_UNIT_CONFLICT")
  if (!hasSupplier) calculation.missing_data.push("SUPPLIER")
  calculation.missing_data = [...new Set(calculation.missing_data)].sort()
  calculation.warnings = [...new Set(calculation.warnings)].sort()
}

function hasBlockingScopeData(calculation: ReturnType<typeof calculateReplenishment>): boolean {
  return calculation.missing_data.some((item) => [
    "MINIMUM_STOCK",
    "STOCK_UNIT",
    "STOCK_UNIT_CONFLICT",
    "OPEN_ORDER_UNIT_CONVERSION",
    "SITE",
  ].includes(item))
}

function allocateCoverage(total: number, stockLevelIds: string[]): Array<{ stock_level_id: string; quantity: number }> {
  if (!stockLevelIds.length || total <= 0) return []
  const base = Math.max(0.001, Math.floor((total * 1000) / stockLevelIds.length) / 1000)
  let allocated = 0
  return stockLevelIds.map((stockLevelId, index) => {
    const quantity = index === stockLevelIds.length - 1
      ? Math.max(0.001, Math.round((total - allocated) * 1000) / 1000)
      : base
    allocated += quantity
    return { stock_level_id: stockLevelId, quantity }
  })
}

async function upsertProposal(queryer: Queryer, context: StockContext, actorId: number | null) {
  const candidates = await loadCandidates(queryer, context)
  const selected = candidates.find((candidate) => candidate.preferred && candidate.blockers.length === 0)
    ?? candidates.find((candidate) => candidate.blockers.length === 0)
    ?? null
  const calculation = calculateReplenishment({
    qty_on_hand: context.qty_on_hand, qty_reserved: context.qty_reserved, qty_available: context.qty_available,
    qty_open_orders: context.qty_open_orders, open_order_conversion_missing: context.open_order_conversion_missing,
    minimum_stock_qty: context.min_qty,
    safety_stock_qty: context.safety_stock_qty, target_stock_qty: context.target_stock_qty,
    reorder_qty: context.reorder_qty, stock_unit: context.stock_unit,
    purchase_unit: selected?.purchase_unit ?? null,
    stock_units_per_purchase_unit: selected?.stock_units_per_purchase_unit ?? null,
    supplier_moq: selected?.moq ?? null, purchase_lot_size: selected?.purchase_lot_size ?? null,
    unit_price: selected?.unit_price ?? null,
  })
  addScopeMissingData(calculation, context, Boolean(selected))
  const budget = await budgetFor(queryer, context, selected, calculation.estimated_total)
  if (budget.status === "MISSING") calculation.warnings.push("BUDGET_MISSING")
  if (selected?.price_source === "HISTORICAL") calculation.warnings.push("HISTORICAL_PRICE")
  calculation.warnings = [...new Set(calculation.warnings)].sort()
  const status = hasBlockingScopeData(calculation) || (calculation.net_requirement_qty > 0 && calculation.missing_data.length > 0)
    ? "A_COMPLETER"
    : calculation.net_requirement_qty <= 0
      ? "RESOLUE"
      : "PROPOSEE"
  const calcJson = { ...calculation, inputs: context }
  const existing = await queryer.query(
    `SELECT id::text, status FROM public.replenishment_proposals
      WHERE article_id = $1::uuid AND magasin_id IS NOT DISTINCT FROM $2::uuid`,
    [context.article_id, context.magasin_id]
  )
  const conflictTarget = context.magasin_id
    ? "(article_id, magasin_id) WHERE magasin_id IS NOT NULL"
    : "(article_id) WHERE magasin_id IS NULL"
  const result = await queryer.query<{ id: string }>(
    `INSERT INTO public.replenishment_proposals (
       stock_level_ids, article_id, magasin_id, status, reason_code, stock_unit,
       qty_on_hand, qty_reserved, qty_available, qty_open_orders, minimum_stock_qty, safety_stock_qty,
       target_stock_qty, net_requirement_qty, selected_catalogue_id, selected_supplier_id,
       purchase_unit, stock_units_per_purchase_unit, proposed_purchase_qty, proposed_stock_qty,
       unit_price, currency, estimated_total, budget_status, budget_remaining, missing_data, warnings, calculation,
       resolution_reason)
     VALUES ($1::uuid[],$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
       $15::uuid,$16::uuid,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::text[],$27::text[],$28::jsonb,$29)
     ON CONFLICT ${conflictTarget} DO UPDATE SET
       stock_level_ids=EXCLUDED.stock_level_ids,
       status=EXCLUDED.status, version=replenishment_proposals.version+1, reason_code=EXCLUDED.reason_code,
       stock_unit=EXCLUDED.stock_unit, qty_on_hand=EXCLUDED.qty_on_hand, qty_reserved=EXCLUDED.qty_reserved,
       qty_available=EXCLUDED.qty_available, qty_open_orders=EXCLUDED.qty_open_orders,
       minimum_stock_qty=EXCLUDED.minimum_stock_qty, safety_stock_qty=EXCLUDED.safety_stock_qty,
       target_stock_qty=EXCLUDED.target_stock_qty, net_requirement_qty=EXCLUDED.net_requirement_qty,
       selected_catalogue_id=EXCLUDED.selected_catalogue_id, selected_supplier_id=EXCLUDED.selected_supplier_id,
       purchase_unit=EXCLUDED.purchase_unit, stock_units_per_purchase_unit=EXCLUDED.stock_units_per_purchase_unit,
       proposed_purchase_qty=EXCLUDED.proposed_purchase_qty, proposed_stock_qty=EXCLUDED.proposed_stock_qty,
       unit_price=EXCLUDED.unit_price, currency=EXCLUDED.currency, estimated_total=EXCLUDED.estimated_total,
       budget_status=EXCLUDED.budget_status, budget_remaining=EXCLUDED.budget_remaining,
       missing_data=EXCLUDED.missing_data, warnings=EXCLUDED.warnings, calculation=EXCLUDED.calculation,
       resolution_reason=EXCLUDED.resolution_reason, last_recalculated_at=now(), updated_at=now()
     RETURNING id::text`,
    [context.stock_level_ids, context.article_id, context.magasin_id, status,
      calculation.reason_code, context.stock_unit, context.qty_on_hand, context.qty_reserved, context.qty_available,
      context.qty_open_orders, context.min_qty, context.safety_stock_qty, calculation.target_stock_qty,
      calculation.net_requirement_qty, selected?.catalogue_id ?? null, selected?.supplier_id ?? null,
      selected?.purchase_unit ?? null, calculation.stock_units_per_purchase_unit,
      calculation.proposed_purchase_qty, calculation.proposed_stock_qty, selected?.unit_price ?? null,
      selected?.currency ?? null, calculation.estimated_total, budget.status, budget.remaining,
      calculation.missing_data, calculation.warnings, JSON.stringify(calcJson),
      status === "RESOLUE" ? "Stock disponible et commandes ouvertes couvrent la cible" : null]
  )
  const id = result.rows[0].id
  if (!existing.rows[0] || existing.rows[0].status !== status) {
    await queryer.query(
      `INSERT INTO public.replenishment_proposal_events
         (proposal_id,event_type,from_status,to_status,calculation,details,actor_id)
       VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
      [id, existing.rows[0] ? "RECALCULATED" : "GENERATED", existing.rows[0]?.status ?? null, status,
        JSON.stringify(calcJson), JSON.stringify({
          article_id: context.article_id,
          magasin_id: context.magasin_id,
          stock_level_ids: context.stock_level_ids,
          selected_catalogue_id: selected?.catalogue_id ?? null,
        }), actorId]
    )
  }
  return { id, status }
}

async function hydrateProposals(queryer: Queryer, filters: ListReplenishmentProposalsDTO): Promise<ReplenishmentProposal[]> {
  const values: unknown[] = []
  const where: string[] = []
  const push = (value: unknown) => { values.push(value); return `$${values.length}` }
  if (filters.status) where.push(`p.status = ${push(filters.status)}`)
  else where.push(`p.status IN ('PROPOSEE','A_COMPLETER','CONVERTIE')`)
  if (filters.magasin_id) where.push(`p.magasin_id = ${push(filters.magasin_id)}::uuid`)
  if (filters.article_id) where.push(`p.article_id = ${push(filters.article_id)}::uuid`)
  values.push(filters.limit)
  const result = await queryer.query(
    `SELECT p.*, a.code AS article_code, a.designation AS article_designation,
            COALESCE(m.name,m.libelle,m.code_magasin)::text AS magasin_name,
            cf.code AS commande_fournisseur_code
       FROM public.replenishment_proposals p
       JOIN public.articles a ON a.id = p.article_id
       LEFT JOIN public.magasins m ON m.id = p.magasin_id
       LEFT JOIN public.commande_fournisseur cf ON cf.id = p.commande_fournisseur_id
      WHERE ${where.join(" AND ")}
      ORDER BY CASE p.status WHEN 'A_COMPLETER' THEN 0 WHEN 'PROPOSEE' THEN 1 ELSE 2 END,
               p.net_requirement_qty DESC, a.code
      LIMIT $${values.length}`,
    values
  )
  const items: ReplenishmentProposal[] = []
  for (const row of result.rows) {
    const contexts = await readStockContexts(queryer, {
      scope: { article_id: row.article_id, magasin_id: row.magasin_id ?? null },
      limit: 1,
    })
    const candidates = contexts[0] ? await loadCandidates(queryer, contexts[0]) : []
    items.push({
      id: row.id, status: row.status, version: Number(row.version), reason_code: row.reason_code,
      article_id: row.article_id, article_code: row.article_code, article_designation: row.article_designation,
      stock_level_ids: row.stock_level_ids ?? [], stock_level_count: (row.stock_level_ids ?? []).length,
      magasin_id: row.magasin_id ?? null, magasin_name: row.magasin_name ?? null,
      emplacement_name: (row.stock_level_ids ?? []).length > 1 ? `${row.stock_level_ids.length} emplacements` : null,
      stock_unit: row.stock_unit ?? null,
      qty_on_hand: n(row.qty_on_hand), qty_reserved: n(row.qty_reserved), qty_available: n(row.qty_available),
      qty_open_orders: n(row.qty_open_orders), minimum_stock_qty: nullableNumber(row.minimum_stock_qty),
      safety_stock_qty: nullableNumber(row.safety_stock_qty), target_stock_qty: nullableNumber(row.target_stock_qty),
      net_requirement_qty: n(row.net_requirement_qty), selected_catalogue_id: row.selected_catalogue_id ?? null,
      proposed_purchase_qty: nullableNumber(row.proposed_purchase_qty), proposed_stock_qty: nullableNumber(row.proposed_stock_qty),
      unit_price: nullableNumber(row.unit_price), currency: row.currency ?? null, estimated_total: nullableNumber(row.estimated_total),
      budget_status: row.budget_status, budget_remaining: nullableNumber(row.budget_remaining),
      missing_data: row.missing_data ?? [], warnings: row.warnings ?? [], calculation: row.calculation ?? {}, candidates,
      commande_fournisseur_id: row.commande_fournisseur_id ?? null,
      commande_fournisseur_code: row.commande_fournisseur_code ?? null,
      last_recalculated_at: row.last_recalculated_at, updated_at: row.updated_at,
    })
  }
  return items
}

export function repoListReplenishmentProposals(filters: ListReplenishmentProposalsDTO) {
  return hydrateProposals(db, filters)
}

export async function repoRefreshReplenishmentProposals(
  filters: RefreshReplenishmentProposalsDTO,
  context: AuditContext
): Promise<ReplenishmentRefreshResult> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const stocks = await readStockContexts(client, filters)
    let resolved = 0
    for (const stock of stocks) {
      const out = await upsertProposal(client, stock, context.user_id)
      if (out.status === "RESOLUE") resolved += 1
    }
    await client.query("COMMIT")
    const items = await hydrateProposals(db, { ...filters, limit: filters.limit })
    return { items, refreshed: stocks.length, resolved, as_of: new Date().toISOString() }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function repoValidateReplenishmentProposal(
  id: string,
  body: ValidateReplenishmentProposalDTO,
  context: AuditContext
): Promise<Record<string, unknown>> {
  const client = await db.connect()
  const requestHash = hashRequest({ id, ...body })
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
    const replay = await client.query(
      `SELECT request_hash, result FROM public.replenishment_proposal_idempotence
       WHERE actor_id=$1 AND idempotency_key=$2`, [context.user_id, body.idempotency_key]
    )
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== requestHash) throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Clé d'idempotence déjà utilisée avec une autre demande.")
      await client.query("COMMIT")
      return { ...replay.rows[0].result, idempotent_replay: true }
    }

    const locked = await client.query(
      `SELECT p.*, cf.code AS commande_code, cf.statut AS commande_statut FROM public.replenishment_proposals p
       LEFT JOIN public.commande_fournisseur cf ON cf.id=p.commande_fournisseur_id
       WHERE p.id=$1::uuid FOR UPDATE OF p`, [id]
    )
    const proposal = locked.rows[0]
    if (!proposal) throw new HttpError(404, "REPLENISHMENT_PROPOSAL_NOT_FOUND", "Proposition introuvable.")
    if (Number(proposal.version) !== body.expected_version) throw new HttpError(409, "CONCURRENT_MODIFICATION", "La proposition a changé; rechargez le calcul.")
    if (proposal.commande_fournisseur_id && proposal.commande_code && proposal.commande_statut !== "ANNULEE") {
      const result = {
        converted: true,
        proposal_id: id,
        commande_fournisseur_id: proposal.commande_fournisseur_id,
        code: proposal.commande_code,
        status: proposal.commande_statut ?? "BROUILLON",
      }
      await client.query(
        `INSERT INTO public.replenishment_proposal_idempotence(actor_id,idempotency_key,request_hash,proposal_id,result)
         VALUES($1,$2,$3,$4::uuid,$5::jsonb)`, [context.user_id, body.idempotency_key, requestHash, id, JSON.stringify(result)]
      )
      await client.query("COMMIT")
      return { ...result, idempotent_replay: true }
    }

    const stockLevelIds = Array.isArray(proposal.stock_level_ids) ? proposal.stock_level_ids as string[] : []
    if (!stockLevelIds.length) {
      throw new HttpError(409, "REPLENISHMENT_SOURCE_CHANGED", "Le périmètre article/site n'a plus de niveaux de stock.")
    }
    const lockedLevels = await client.query(
      `SELECT id FROM public.stock_levels WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [stockLevelIds]
    )
    if (lockedLevels.rowCount !== stockLevelIds.length) {
      throw new HttpError(409, "REPLENISHMENT_SOURCE_CHANGED", "Le périmètre article/site a changé; relancez le calcul.")
    }
    const stock = (await readStockContexts(client, {
      scope: { article_id: proposal.article_id, magasin_id: proposal.magasin_id ?? null },
      limit: 1,
    }))[0]
    if (!stock) throw new HttpError(409, "REPLENISHMENT_SOURCE_CHANGED", "Le périmètre article/site n'est plus géré.")
    if (stock.stock_level_ids.join(",") !== [...stockLevelIds].sort().join(",")) {
      throw new HttpError(409, "REPLENISHMENT_SOURCE_CHANGED", "Les niveaux du périmètre article/site ont changé; relancez le calcul.")
    }
    const candidates = await loadCandidates(client, stock)
    const candidate = candidates.find((item) => item.catalogue_id === body.catalogue_id)
    if (!candidate) throw new HttpError(422, "SUPPLIER_CANDIDATE_INVALID", "Le fournisseur ou son catalogue n'est plus disponible.")
    if (candidate.blockers.length) throw new HttpError(422, "UNIT_CONVERSION_REQUIRED", "La conversion d'unité du catalogue est incomplète.", { blockers: candidate.blockers })
    const calculation = calculateReplenishment({
      qty_on_hand: stock.qty_on_hand, qty_reserved: stock.qty_reserved, qty_available: stock.qty_available,
      qty_open_orders: stock.qty_open_orders, open_order_conversion_missing: stock.open_order_conversion_missing,
      minimum_stock_qty: stock.min_qty,
      safety_stock_qty: stock.safety_stock_qty, target_stock_qty: stock.target_stock_qty,
      reorder_qty: stock.reorder_qty, stock_unit: stock.stock_unit, purchase_unit: candidate.purchase_unit,
      stock_units_per_purchase_unit: candidate.stock_units_per_purchase_unit, supplier_moq: candidate.moq,
      purchase_lot_size: candidate.purchase_lot_size, unit_price: candidate.unit_price,
    })
    addScopeMissingData(calculation, stock, true)
    if (hasBlockingScopeData(calculation)) {
      throw new HttpError(422, "REPLENISHMENT_DATA_INCOMPLETE", "Le périmètre article/site ou un reliquat historique exige une correction avant validation.", {
        missing_data: calculation.missing_data,
      })
    }
    if (calculation.net_requirement_qty <= 0) {
      await client.query(
        `UPDATE public.replenishment_proposals SET status='RESOLUE',version=version+1,
          net_requirement_qty=0,resolution_reason='Besoin couvert lors de la validation',calculation=$2::jsonb,
          last_recalculated_at=now(),updated_at=now() WHERE id=$1::uuid`, [id, JSON.stringify(calculation)]
      )
      await client.query(
        `INSERT INTO public.replenishment_proposal_events(proposal_id,event_type,from_status,to_status,calculation,actor_id)
         VALUES($1::uuid,'RESOLVED_AT_VALIDATION',$2,'RESOLUE',$3::jsonb,$4)`, [id, proposal.status, JSON.stringify(calculation), context.user_id]
      )
      const result = { converted: false, proposal_id: id, status: "RESOLUE", recalculated: calculation }
      await client.query(
        `INSERT INTO public.replenishment_proposal_idempotence(actor_id,idempotency_key,request_hash,proposal_id,result)
         VALUES($1,$2,$3,$4::uuid,$5::jsonb)`, [context.user_id, body.idempotency_key, requestHash, id, JSON.stringify(result)]
      )
      await audit(client, context, "replenishment_proposals.validation.resolved", id, { calculation })
      await client.query("COMMIT")
      return { ...result, idempotent_replay: false }
    }
    if (calculation.missing_data.length || calculation.proposed_purchase_qty == null || calculation.proposed_stock_qty == null) {
      throw new HttpError(422, "REPLENISHMENT_DATA_INCOMPLETE", "La proposition ne peut pas être convertie tant que ses données obligatoires manquent.", { missing_data: calculation.missing_data })
    }
    const budget = await budgetFor(client, stock, candidate, calculation.estimated_total)
    if (budget.status === "EXCEEDED") throw new HttpError(422, "REPLENISHMENT_BUDGET_EXCEEDED", "Le budget configuré est insuffisant pour ce brouillon.", { remaining: budget.remaining, estimate: calculation.estimated_total })

    const code = await generateCommandeFournisseurCode(client)
    const totals = computeCommandeTotaux([{
      quantite: calculation.proposed_purchase_qty,
      prix_unitaire_ht: candidate.unit_price ?? 0,
      remise_pct: 0, tva_pct: 20, frais_ht: 0,
    }], { frais_port_ht: 0, tva_frais_pct: 20 })
    const header = await client.query<{ id: string }>(
      `INSERT INTO public.commande_fournisseur
        (code,statut,origine,fournisseur_id,magasin_livraison_id,devise,note_interne,total_ht,total_remise,total_tva,total_ttc,
         replenishment_proposal_id,created_by,updated_by)
       VALUES($1,'BROUILLON','SEUIL_STOCK',$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::uuid,$11,$11)
       RETURNING id::text`,
      [code, candidate.supplier_id, stock.magasin_id, candidate.currency,
        `Créée après validation humaine de la proposition ${id}. Budget: ${budget.status}.`,
        totals.total_ht, totals.total_remise, totals.total_tva, totals.total_ttc, id, context.user_id]
    )
    const orderId = header.rows[0].id
    const line = await client.query<{ id: string }>(
      `INSERT INTO public.commande_fournisseur_ligne
        (commande_id,position,type,article_id,catalogue_id,designation,unite,unite_stock,coef_conversion,
         quantite,prix_unitaire_ht,remise_pct,tva_pct,frais_ht,delai_jours,magasin_id,created_by,updated_by)
       VALUES($1::uuid,1,'ARTICLE',$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,0,20,0,$10,$11::uuid,$12,$12)
       RETURNING id::text`,
      [orderId, stock.article_id, candidate.catalogue_id, stock.article_designation, candidate.purchase_unit,
        stock.stock_unit, calculation.stock_units_per_purchase_unit, calculation.proposed_purchase_qty,
        candidate.unit_price ?? 0, candidate.lead_time_days, stock.magasin_id, context.user_id]
    )
    for (const coverage of allocateCoverage(calculation.proposed_stock_qty, stock.stock_level_ids)) {
      await client.query(
        `INSERT INTO public.commande_fournisseur_ligne_besoin
          (ligne_id,besoin_type,besoin_ref,besoin_of_id,quantite_couverte)
         VALUES($1::uuid,'STOCK_LEVEL',$2,0,$3)`,
        [line.rows[0].id, coverage.stock_level_id, coverage.quantity]
      )
    }
    await client.query(
      `INSERT INTO public.commande_fournisseur_transition(commande_id,from_statut,to_statut,motif,acteur_id)
       VALUES($1::uuid,NULL,'BROUILLON','Validation humaine d''une proposition de réapprovisionnement',$2)`, [orderId, context.user_id]
    )
    await client.query(
      `UPDATE public.replenishment_proposals SET status='CONVERTIE',version=version+1,
        selected_catalogue_id=$2::uuid,selected_supplier_id=$3::uuid,purchase_unit=$4,
        stock_units_per_purchase_unit=$5,proposed_purchase_qty=$6,proposed_stock_qty=$7,
        unit_price=$8,currency=$9,estimated_total=$10,budget_status=$11,budget_remaining=$12,
        calculation=$13::jsonb,commande_fournisseur_id=$14::uuid,commande_fournisseur_ligne_id=$15::uuid,
        validated_at=now(),validated_by=$16,last_recalculated_at=now(),updated_at=now()
       WHERE id=$1::uuid`,
      [id, candidate.catalogue_id, candidate.supplier_id, candidate.purchase_unit,
        calculation.stock_units_per_purchase_unit, calculation.proposed_purchase_qty, calculation.proposed_stock_qty,
        candidate.unit_price, candidate.currency, calculation.estimated_total, budget.status, budget.remaining,
        JSON.stringify(calculation), orderId, line.rows[0].id, context.user_id]
    )
    await client.query(
      `INSERT INTO public.replenishment_proposal_events(proposal_id,event_type,from_status,to_status,calculation,details,actor_id)
       VALUES($1::uuid,'VALIDATED',$2,'CONVERTIE',$3::jsonb,$4::jsonb,$5)`,
      [id, proposal.status, JSON.stringify(calculation), JSON.stringify({ commande_fournisseur_id: orderId, code, catalogue_id: candidate.catalogue_id }), context.user_id]
    )
    const result = { converted: true, proposal_id: id, commande_fournisseur_id: orderId, code, status: "BROUILLON", recalculated: calculation }
    await client.query(
      `INSERT INTO public.replenishment_proposal_idempotence(actor_id,idempotency_key,request_hash,proposal_id,result)
       VALUES($1,$2,$3,$4::uuid,$5::jsonb)`, [context.user_id, body.idempotency_key, requestHash, id, JSON.stringify(result)]
    )
    await audit(client, context, "replenishment_proposals.validation.converted", id, {
      commande_fournisseur_id: orderId, code, supplier_id: candidate.supplier_id,
      calculation, budget_status: budget.status,
    })
    await client.query("COMMIT")
    return { ...result, idempotent_replay: false }
  } catch (error) {
    await client.query("ROLLBACK")
    if ((error as { code?: string })?.code === "40001") {
      throw new HttpError(409, "REPLENISHMENT_RETRY", "Le stock ou une commande a changé pendant la validation; rechargez la proposition.")
    }
    if ((error as { code?: string; constraint?: string })?.code === "23505") {
      throw new HttpError(409, "REPLENISHMENT_ALREADY_CONVERTED", "Une commande couvre déjà cette proposition.")
    }
    throw error
  } finally {
    client.release()
  }
}
