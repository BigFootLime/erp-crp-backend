import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import type { PoolClient } from "pg"

import pool from "../../../config/database"
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction"
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service"
import { canonicalizeStockUnitCode } from "../../../shared/stock-unit"
import { transferSecureUploadToDestination } from "../../../shared/uploads/secure-upload"
import { classifyUploadReconciliation, withUploadTransaction } from "../../../shared/uploads/upload-transaction"
import { ensureDocumentStoragePath } from "../../../utils/cerpStorage"
import { HttpError } from "../../../utils/httpError"
import { normalizeCommandeWorkflowStatus } from "../../commande-client/workflow/commande-client-workflow.definition"

import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"
import {
  assertOperationalLotQualityEligibility,
  recordDirectLotQualityConsumption,
} from "../../qualite/repository/quality-operational-gate.repository"
import { isLivraisonTransitionAllowed } from "../domain/livraisons-policy"
import {
  assertStockConsumptionAllowed,
  getEmplacementMapping as getStockEmplacementMapping,
  lockStockStates,
  stockTargetKey,
} from "../../stock/repository/stock.repository"
import {
  prepareLivraisonInTransaction,
  releaseLivraisonReservationsInTransaction,
  repoListLivraisonProofs,
} from "./livraisons-shipment.repository"

import type {
  AdresseLivraisonLite,
  BonLivraisonDetail,
  BonLivraisonDocument,
  BonLivraisonEventLog,
  BonLivraisonHeader,
  BonLivraisonLigne,
  BonLivraisonLigneAllocation,
  BonLivraisonListItem,
  BonLivraisonListSummary,
  BonLivraisonStatut,
  Paginated,
  UploadedDocument,
  UserLite,
} from "../types/livraisons.types"

type LegacyShipmentReservationAllocation = {
  allocation_id: string
  quantite: number
  reservation_id: string | null
  reservation_status: string | null
  reservation_qty: string | number | null
}

/**
 * A legacy allocation can point at an ACTIVE stock reservation or be a direct
 * issue. Never turn a partial reservation into a full consumption: that would
 * either erase another delivery's commitment or double-spend Quality capacity.
 */
export function buildLegacyShipmentReservationPlan(items: readonly LegacyShipmentReservationAllocation[]): {
  committed_qty: number
  direct_qty: number
  reservation_ids: string[]
} {
  const reservations = new Map<string, { allocated: number; reserved: number }>()
  let directQty = 0
  for (const item of items) {
    if (item.reservation_id && item.reservation_status === "ACTIVE") {
      const reserved = Number(item.reservation_qty)
      if (!Number.isFinite(reserved) || reserved <= 0) {
        throw new HttpError(409, "RESERVATION_ALLOCATION_MISMATCH", "La réservation du BL est invalide.")
      }
      const existing = reservations.get(item.reservation_id)
      if (existing && Math.abs(existing.reserved - reserved) > 1e-9) {
        throw new HttpError(409, "RESERVATION_ALLOCATION_MISMATCH", "La réservation du BL est incohérente.")
      }
      reservations.set(item.reservation_id, { allocated: (existing?.allocated ?? 0) + item.quantite, reserved })
    } else {
      directQty += item.quantite
    }
  }
  for (const reservation of reservations.values()) {
    if (Math.abs(reservation.allocated - reservation.reserved) > 1e-9) {
      throw new HttpError(
        409,
        "RESERVATION_ALLOCATION_MISMATCH",
        "La quantité allouée ne correspond pas exactement à la réservation active du BL."
      )
    }
  }
  return {
    committed_qty: [...reservations.values()].reduce((sum, reservation) => sum + reservation.allocated, 0),
    direct_qty: directQty,
    reservation_ids: [...reservations.keys()].sort(),
  }
}
import type {
  CreateLivraisonAllocationBodyDTO,
  CreateLivraisonBodyDTO,
  CreateLivraisonLineBodyDTO,
  ListLivraisonsQueryDTO,
  UpdateLivraisonBodyDTO,
  UpdateLivraisonLineBodyDTO,
} from "../validators/livraisons.validators"

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10)
  throw new Error(`Invalid ${label}: ${String(value)}`)
}

function toFloat(value: unknown, label = "value"): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  throw new Error(`Invalid ${label}: ${String(value)}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getPgErrorInfo(err: unknown) {
  if (!isRecord(err)) return { code: null as string | null, constraint: null as string | null }
  const code = typeof err.code === "string" ? err.code : null
  const constraint = typeof err.constraint === "string" ? err.constraint : null
  return { code, constraint }
}

type Queryable = Pick<PoolClient, "query">

const DEFAULT_SHIPPING_LOCATION_SETTING_KEY = "stock.default_shipping_location"

function isUuidString(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F-]{36}$/.test(value)
}

type ShippingLocationSetting = {
  magasin_id: string
  emplacement_id: number
}

type EmplacementMapping = {
  magasin_id: string
  location_id: string
  warehouse_id: string
}

async function getEmplacementMapping(
  db: Queryable,
  magasinId: string,
  emplacementId: number,
  label: "shipping" | "src" | "dst"
): Promise<EmplacementMapping> {
  const res = await db.query<{
    magasin_id: string
    is_active: boolean
    is_scrap: boolean
    location_id: string | null
    warehouse_id: string | null
  }>(
    `
      SELECT
        e.magasin_id::text AS magasin_id,
        e.is_active,
        e.is_scrap,
        e.location_id::text AS location_id,
        l.warehouse_id::text AS warehouse_id
      FROM public.emplacements e
      LEFT JOIN public.locations l ON l.id = e.location_id
      WHERE e.id = $1::bigint
    `,
    [emplacementId]
  )

  const row = res.rows[0] ?? null
  if (!row) {
    throw new HttpError(400, "INVALID_LOCATION", `Unknown ${label}_emplacement_id`)
  }
  if (row.magasin_id !== magasinId) {
    throw new HttpError(400, "INVALID_LOCATION", `${label}_emplacement_id does not belong to ${label}_magasin_id`)
  }
  if (!row.is_active || row.is_scrap) {
    throw new HttpError(409, "INVALID_LOCATION", `${label} emplacement is not usable for shipping`)
  }
  if (!row.location_id || !row.warehouse_id) {
    throw new HttpError(409, "LOCATION_NOT_MAPPED", "Shipping emplacement is missing location mapping")
  }

  return {
    magasin_id: row.magasin_id,
    location_id: row.location_id,
    warehouse_id: row.warehouse_id,
  }
}

async function getDefaultShippingLocationSetting(db: Queryable): Promise<ShippingLocationSetting> {
  const res = await db.query<{ value_json: unknown }>(
    `SELECT value_json FROM public.erp_settings WHERE key = $1`,
    [DEFAULT_SHIPPING_LOCATION_SETTING_KEY]
  )

  const raw = res.rows[0]?.value_json ?? null
  if (!isRecord(raw)) {
    throw new HttpError(
      409,
      "SHIPPING_LOCATION_NOT_CONFIGURED",
      `Missing setting ${DEFAULT_SHIPPING_LOCATION_SETTING_KEY} in public.erp_settings`
    )
  }

  const magasinId = raw.magasin_id
  const emplacementIdRaw = raw.emplacement_id
  const emplacementId =
    typeof emplacementIdRaw === "number" && Number.isInteger(emplacementIdRaw)
      ? emplacementIdRaw
      : typeof emplacementIdRaw === "string" && /^\d+$/.test(emplacementIdRaw)
        ? Number.parseInt(emplacementIdRaw, 10)
        : NaN

  if (!isUuidString(magasinId) || !Number.isFinite(emplacementId) || emplacementId <= 0) {
    throw new HttpError(
      409,
      "SHIPPING_LOCATION_NOT_CONFIGURED",
      `Invalid ${DEFAULT_SHIPPING_LOCATION_SETTING_KEY} format (expected {magasin_id, emplacement_id})`
    )
  }

  return { magasin_id: magasinId, emplacement_id: emplacementId }
}

function stockMovementNoFromSeq(n: number): string {
  const padded = String(n).padStart(8, "0")
  return `SM-${padded}`
}

async function reserveStockMovementNo(db: Queryable): Promise<string> {
  const res = await db.query<{ n: string }>(`SELECT nextval('public.stock_movement_no_seq')::text AS n`)
  const raw = res.rows[0]?.n
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n)) throw new Error("Failed to reserve stock movement number")
  return stockMovementNoFromSeq(n)
}

export async function resolveUnitIdForArticle(
  db: Queryable,
  articleId: string,
  preferredUnitCode: string | null | undefined
): Promise<string> {
  const preferred = preferredUnitCode?.trim() ? preferredUnitCode.trim() : null
  let code: string | null = preferred

  if (!code) {
    const a = await db.query<{ unite: string | null }>(`SELECT unite FROM public.articles WHERE id = $1::uuid`, [articleId])
    code = a.rows[0]?.unite?.trim() ? a.rows[0].unite.trim() : null
  }
  code = canonicalizeStockUnitCode(code) ?? "u"

  const u = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM public.units WHERE lower(code::text) = lower($1) LIMIT 1`,
    [code]
  )
  const unitId = u.rows[0]?.id
  if (!unitId) {
    throw new HttpError(400, "UNKNOWN_UNIT", `Unknown unit code: ${code}`)
  }
  return unitId
}

async function ensureStockLevel(
  db: Queryable,
  args: {
    article_id: string
    unit_id: string
    warehouse_id: string
    location_id: string
    actor_user_id: number
  }
): Promise<string> {
  const existing = await db.query<{ id: string; unit_id: string; warehouse_id: string }>(
    `
      SELECT
        id::text AS id,
        unit_id::text AS unit_id,
        warehouse_id::text AS warehouse_id
      FROM public.stock_levels
      WHERE article_id = $1::uuid AND location_id = $2::uuid
    `,
    [args.article_id, args.location_id]
  )

  const row = existing.rows[0] ?? null
  if (row) {
    if (row.unit_id !== args.unit_id) {
      throw new HttpError(409, "STOCK_LEVEL_UNIT_MISMATCH", "Stock level unit mismatch")
    }
    if (row.warehouse_id !== args.warehouse_id) {
      throw new HttpError(409, "STOCK_LEVEL_WAREHOUSE_MISMATCH", "Stock level warehouse mismatch")
    }
    return row.id
  }

  await db.query(
    `
      INSERT INTO public.stock_levels (
        article_id, unit_id, warehouse_id, location_id,
        managed_in_stock,
        created_by, updated_by
      )
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,true,$5,$5)
      ON CONFLICT (article_id, location_id) DO NOTHING
    `,
    [args.article_id, args.unit_id, args.warehouse_id, args.location_id, args.actor_user_id]
  )

  const after = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM public.stock_levels WHERE article_id = $1::uuid AND location_id = $2::uuid`,
    [args.article_id, args.location_id]
  )
  const id = after.rows[0]?.id
  if (!id) throw new Error("Failed to ensure stock level")
  return id
}

async function ensureStockBatchId(db: Queryable, args: { stock_level_id: string; lot_id: string }): Promise<string> {
  const lot = await db.query<{ lot_code: string }>(`SELECT lot_code FROM public.lots WHERE id = $1::uuid`, [args.lot_id])
  const lotCode = lot.rows[0]?.lot_code
  if (!lotCode) throw new HttpError(400, "INVALID_LOT", "Unknown lot_id")

  await db.query(
    `
      INSERT INTO public.stock_batches (stock_level_id, batch_code)
      VALUES ($1::uuid,$2)
      ON CONFLICT (stock_level_id, batch_code) DO NOTHING
    `,
    [args.stock_level_id, lotCode]
  )

  const b = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM public.stock_batches WHERE stock_level_id = $1::uuid AND batch_code = $2`,
    [args.stock_level_id, lotCode]
  )
  const id = b.rows[0]?.id
  if (!id) throw new Error("Failed to ensure stock batch")
  return id
}

async function insertStockMovementEvent(
  db: Queryable,
  args: {
    movement_id: string
    event_type: string
    old_values: unknown | null
    new_values: unknown | null
    user_id: number
  }
) {
  await db.query(
    `
      INSERT INTO public.stock_movement_event_log (
        stock_movement_id, event_type, old_values, new_values,
        user_id,
        created_by, updated_by
      )
      VALUES ($1::uuid,$2,$3::jsonb,$4::jsonb,$5,$5,$5)
    `,
    [args.movement_id, args.event_type, JSON.stringify(args.old_values), JSON.stringify(args.new_values), args.user_id]
  )
}

let commandeToAffaireHasRoleColumnCache: boolean | null = null
async function hasCommandeToAffaireRoleColumn(db: Queryable): Promise<boolean> {
  if (commandeToAffaireHasRoleColumnCache !== null) return commandeToAffaireHasRoleColumnCache

  const res = await db.query<{ ok: number }>(
    `
    SELECT 1::int AS ok
    FROM pg_attribute
    WHERE attrelid = to_regclass('public.commande_to_affaire')
      AND attname = 'role'
      AND NOT attisdropped
    LIMIT 1
    `
  )

  commandeToAffaireHasRoleColumnCache = res.rows.length > 0
  return commandeToAffaireHasRoleColumnCache
}

function mapUserLite(row: {
  id: number | null
  username: string | null
  name: string | null
  surname: string | null
}): UserLite | null {
  if (!row.id || !row.username) return null
  const parts = [row.surname ?? "", row.name ?? ""].map((s) => s.trim()).filter(Boolean)
  const label = parts.join(" ").trim() || row.username
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    surname: row.surname,
    label,
  }
}

function formatAddressInline(a: {
  name: string | null
  street: string | null
  house_number: string | null
  postal_code: string | null
  city: string | null
  country: string | null
}): string {
  const line1 = [a.street, a.house_number].map((s) => (s ?? "").trim()).filter(Boolean).join(" ")
  const line2 = [a.postal_code, a.city].map((s) => (s ?? "").trim()).filter(Boolean).join(" ")
  const parts = [a.name, line1, line2, a.country].map((s) => (s ?? "").trim()).filter(Boolean)
  return parts.join(", ")
}

function sortColumn(sortBy: ListLivraisonsQueryDTO["sortBy"]) {
  switch (sortBy) {
    case "numero":
      return "bl.numero"
    case "statut":
      return "bl.statut"
    case "updated_at":
      return "bl.updated_at"
    case "date_creation":
    default:
      return "bl.date_creation"
  }
}

function sortDirection(sortDir: ListLivraisonsQueryDTO["sortDir"]) {
  return sortDir === "asc" ? "ASC" : "DESC"
}

type ListWhere = { whereSql: string; values: unknown[] }
function buildListWhere(filters: ListLivraisonsQueryDTO): ListWhere {
  const where: string[] = []
  const values: unknown[] = []
  const push = (v: unknown) => {
    values.push(v)
    return `$${values.length}`
  }

  if (filters.q && filters.q.trim().length > 0) {
    const p = push(`%${filters.q.trim()}%`)
    where.push(`(
      bl.numero ILIKE ${p}
      OR c.company_name ILIKE ${p}
      OR (cc.numero IS NOT NULL AND cc.numero ILIKE ${p})
    )`)
  }

  if (filters.client_id && filters.client_id.trim().length > 0) {
    const p = push(filters.client_id.trim())
    where.push(`bl.client_id = ${p}`)
  }

  if (filters.commande_id) {
    const p = push(filters.commande_id)
    where.push(`bl.commande_id = ${p}::bigint`)
  }

  if (filters.statut) {
    const p = push(filters.statut)
    where.push(`bl.statut = ${p}`)
  }

  if (filters.from && filters.from.trim().length > 0) {
    const p = push(filters.from.trim())
    where.push(`bl.date_creation >= ${p}::date`)
  }

  if (filters.to && filters.to.trim().length > 0) {
    const p = push(filters.to.trim())
    where.push(`bl.date_creation <= ${p}::date`)
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    values,
  }
}

export async function repoListLivraisons(
  filters: ListLivraisonsQueryDTO
): Promise<Paginated<BonLivraisonListItem> & { summary: BonLivraisonListSummary }> {
  const page = filters.page ?? 1
  const pageSize = filters.pageSize ?? 50
  const offset = (page - 1) * pageSize

  const { whereSql, values } = buildListWhere(filters)
  const orderBy = sortColumn(filters.sortBy)
  const orderDir = sortDirection(filters.sortDir)

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM bon_livraison bl
    JOIN clients c ON c.client_id = bl.client_id
    LEFT JOIN commande_client cc ON cc.id = bl.commande_id
    ${whereSql}
  `
  const countRes = await pool.query<{ total: number }>(countSql, values)
  const total = countRes.rows[0]?.total ?? 0
  const summaryRes = await pool.query<BonLivraisonListSummary>(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE bl.statut = 'DRAFT')::int AS draft,
        COUNT(*) FILTER (WHERE bl.statut = 'READY')::int AS ready,
        COUNT(*) FILTER (WHERE bl.statut = 'SHIPPED')::int AS shipped,
        COUNT(*) FILTER (WHERE bl.statut = 'DELIVERED')::int AS delivered,
        COUNT(*) FILTER (WHERE bl.statut = 'CANCELLED')::int AS cancelled
      FROM public.bon_livraison bl
      JOIN public.clients c ON c.client_id = bl.client_id
      LEFT JOIN public.commande_client cc ON cc.id = bl.commande_id
      ${whereSql}
    `,
    values
  )
  const summary = summaryRes.rows[0] ?? {
    total: 0,
    draft: 0,
    ready: 0,
    shipped: 0,
    delivered: 0,
    cancelled: 0,
  }

  type Row = {
    id: string
    numero: string
    statut: BonLivraisonStatut
    client_id: string
    client_company_name: string
    commande_id: string | null
    commande_numero: string | null
    affaire_id: string | null
    affaire_reference: string | null
    date_creation: string
    date_expedition: string | null
    date_livraison: string | null
    transporteur: string | null
    tracking_number: string | null
    updated_at: string
  }

  const dataSql = `
    SELECT
      bl.id::text AS id,
      bl.numero,
      bl.statut,
      bl.client_id,
      c.company_name AS client_company_name,
      bl.commande_id::text AS commande_id,
      cc.numero AS commande_numero,
      bl.affaire_id::text AS affaire_id,
      a.reference AS affaire_reference,
      bl.date_creation::text AS date_creation,
      bl.date_expedition::text AS date_expedition,
      bl.date_livraison::text AS date_livraison,
      bl.transporteur,
      bl.tracking_number,
      bl.updated_at::text AS updated_at
    FROM bon_livraison bl
    JOIN clients c ON c.client_id = bl.client_id
    LEFT JOIN commande_client cc ON cc.id = bl.commande_id
    LEFT JOIN affaire a ON a.id = bl.affaire_id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `
  const dataRes = await pool.query<Row>(dataSql, [...values, pageSize, offset])

  const items: BonLivraisonListItem[] = dataRes.rows.map((r: Row) => ({
    id: r.id,
    numero: r.numero,
    statut: r.statut,
    client: { client_id: r.client_id, company_name: r.client_company_name },
    commande: r.commande_id && r.commande_numero ? { id: toInt(r.commande_id, "bon_livraison.commande_id"), numero: r.commande_numero } : null,
    affaire: r.affaire_id && r.affaire_reference ? { id: toInt(r.affaire_id, "bon_livraison.affaire_id"), reference: r.affaire_reference } : null,
    date_creation: r.date_creation,
    date_expedition: r.date_expedition,
    date_livraison: r.date_livraison,
    transporteur: r.transporteur,
    tracking_number: r.tracking_number,
    updated_at: r.updated_at,
  }))

  return { items, total, summary }
}

type HeaderRow = {
  id: string
  numero: string
  statut: BonLivraisonStatut
  client_id: string
  client_company_name: string
  commande_id: string | null
  commande_numero: string | null
  affaire_id: string | null
  affaire_reference: string | null
  adresse_livraison_id: string | null
  al_name: string | null
  al_street: string | null
  al_house_number: string | null
  al_postal_code: string | null
  al_city: string | null
  al_country: string | null
  date_creation: string
  date_expedition: string | null
  date_livraison: string | null
  transporteur: string | null
  tracking_number: string | null
  commentaire_interne: string | null
  commentaire_client: string | null
  reception_nom_signataire: string | null
  reception_date_signature: string | null
  row_version: number
  created_at: string
  updated_at: string
  created_by_id: number | null
  created_by_username: string | null
  created_by_name: string | null
  created_by_surname: string | null
  updated_by_id: number | null
  updated_by_username: string | null
  updated_by_name: string | null
  updated_by_surname: string | null
}

async function getHeader(client: PoolClient, id: string, opts?: { forUpdate?: boolean }): Promise<HeaderRow | null> {
  const lock = opts?.forUpdate ? "FOR UPDATE OF bl" : ""
  const sql = `
    SELECT
      bl.id::text AS id,
      bl.numero,
      bl.statut,
      bl.client_id,
      c.company_name AS client_company_name,
      bl.commande_id::text AS commande_id,
      cc.numero AS commande_numero,
      bl.affaire_id::text AS affaire_id,
      a.reference AS affaire_reference,
      bl.adresse_livraison_id::text AS adresse_livraison_id,
      al.name AS al_name,
      al.street AS al_street,
      al.house_number AS al_house_number,
      al.postal_code AS al_postal_code,
      al.city AS al_city,
      al.country AS al_country,
      bl.date_creation::text AS date_creation,
      bl.date_expedition::text AS date_expedition,
      bl.date_livraison::text AS date_livraison,
      bl.transporteur,
      bl.tracking_number,
      bl.commentaire_interne,
      bl.commentaire_client,
      bl.reception_nom_signataire,
      bl.reception_date_signature::text AS reception_date_signature,
      bl.row_version::int AS row_version,
      bl.created_at::text AS created_at,
      bl.updated_at::text AS updated_at,
      cb.id AS created_by_id,
      cb.username AS created_by_username,
      cb.name AS created_by_name,
      cb.surname AS created_by_surname,
      ub.id AS updated_by_id,
      ub.username AS updated_by_username,
      ub.name AS updated_by_name,
      ub.surname AS updated_by_surname
    FROM bon_livraison bl
    JOIN clients c ON c.client_id = bl.client_id
    LEFT JOIN commande_client cc ON cc.id = bl.commande_id
    LEFT JOIN affaire a ON a.id = bl.affaire_id
    LEFT JOIN adresse_livraison al ON al.delivery_address_id = bl.adresse_livraison_id
    LEFT JOIN users cb ON cb.id = bl.created_by
    LEFT JOIN users ub ON ub.id = bl.updated_by
    WHERE bl.id = $1::uuid
    ${lock}
  `
  const res = await client.query<HeaderRow>(sql, [id])
  return res.rows[0] ?? null
}

export async function repoGetLivraisonStatut(id: string): Promise<BonLivraisonStatut | null> {
  const res = await pool.query<{ statut: BonLivraisonStatut }>(`SELECT statut FROM bon_livraison WHERE id = $1::uuid`, [id])
  return res.rows[0]?.statut ?? null
}

export async function repoGetLivraisonDetail(id: string): Promise<BonLivraisonDetail | null> {
  const db = await pool.connect()
  try {
    const headerRow = await getHeader(db, id)
    if (!headerRow) return null

    const addressRaw = headerRow.adresse_livraison_id
      ? {
          id: headerRow.adresse_livraison_id,
          name: headerRow.al_name,
          street: headerRow.al_street,
          house_number: headerRow.al_house_number,
          postal_code: headerRow.al_postal_code,
          city: headerRow.al_city,
          country: headerRow.al_country,
        }
      : null

    const adresse_livraison: AdresseLivraisonLite = addressRaw
      ? {
          ...addressRaw,
          label: formatAddressInline(addressRaw) || "Adresse de livraison",
        }
      : null

    const createdBy = mapUserLite({
      id: headerRow.created_by_id,
      username: headerRow.created_by_username,
      name: headerRow.created_by_name,
      surname: headerRow.created_by_surname,
    })
    const updatedBy = mapUserLite({
      id: headerRow.updated_by_id,
      username: headerRow.updated_by_username,
      name: headerRow.updated_by_name,
      surname: headerRow.updated_by_surname,
    })

    const bon_livraison: BonLivraisonHeader = {
      id: headerRow.id,
      numero: headerRow.numero,
      statut: headerRow.statut,
      client: { client_id: headerRow.client_id, company_name: headerRow.client_company_name },
      commande: headerRow.commande_id && headerRow.commande_numero ? { id: toInt(headerRow.commande_id, "bon_livraison.commande_id"), numero: headerRow.commande_numero } : null,
      affaire: headerRow.affaire_id && headerRow.affaire_reference ? { id: toInt(headerRow.affaire_id, "bon_livraison.affaire_id"), reference: headerRow.affaire_reference } : null,
      adresse_livraison,
      date_creation: headerRow.date_creation,
      date_expedition: headerRow.date_expedition,
      date_livraison: headerRow.date_livraison,
      transporteur: headerRow.transporteur,
      tracking_number: headerRow.tracking_number,
      commentaire_interne: headerRow.commentaire_interne,
      commentaire_client: headerRow.commentaire_client,
      reception_nom_signataire: headerRow.reception_nom_signataire,
      reception_date_signature: headerRow.reception_date_signature,
      row_version: headerRow.row_version,
      created_at: headerRow.created_at,
      updated_at: headerRow.updated_at,
      created_by: createdBy,
      updated_by: updatedBy,
    }

    // Lines
    type LineRow = {
      id: string
      bon_livraison_id: string
      ordre: number
      designation: string
      code_piece: string | null
      quantite: string | number
      unite: string | null
      commande_ligne_id: string | null
      delai_client: string | null
      created_at: string
      updated_at: string
      created_by_id: number | null
      created_by_username: string | null
      created_by_name: string | null
      created_by_surname: string | null
      updated_by_id: number | null
      updated_by_username: string | null
      updated_by_name: string | null
      updated_by_surname: string | null
    }

    const linesRes = await db.query<LineRow>(
      `
      SELECT
        l.id::text AS id,
        l.bon_livraison_id::text AS bon_livraison_id,
        l.ordre,
        l.designation,
        l.code_piece,
        l.quantite,
        l.unite,
        l.commande_ligne_id::text AS commande_ligne_id,
        l.delai_client,
        l.created_at::text AS created_at,
        l.updated_at::text AS updated_at,
        cb.id AS created_by_id,
        cb.username AS created_by_username,
        cb.name AS created_by_name,
        cb.surname AS created_by_surname,
        ub.id AS updated_by_id,
        ub.username AS updated_by_username,
        ub.name AS updated_by_name,
        ub.surname AS updated_by_surname
      FROM bon_livraison_ligne l
      LEFT JOIN users cb ON cb.id = l.created_by
      LEFT JOIN users ub ON ub.id = l.updated_by
      WHERE l.bon_livraison_id = $1::uuid
      ORDER BY l.ordre ASC, l.id ASC
      `,
      [id]
    )
    const lignes: BonLivraisonLigne[] = linesRes.rows.map((r: LineRow) => ({
      id: r.id,
      bon_livraison_id: r.bon_livraison_id,
      ordre: r.ordre,
      designation: r.designation,
      code_piece: r.code_piece,
      quantite: toFloat(r.quantite, "bon_livraison_ligne.quantite"),
      unite: r.unite,
      commande_ligne_id: r.commande_ligne_id ? toInt(r.commande_ligne_id, "bon_livraison_ligne.commande_ligne_id") : null,
      delai_client: r.delai_client,
      allocations: [],
      created_at: r.created_at,
      updated_at: r.updated_at,
      created_by: mapUserLite({
        id: r.created_by_id,
        username: r.created_by_username,
        name: r.created_by_name,
        surname: r.created_by_surname,
      }),
      updated_by: mapUserLite({
        id: r.updated_by_id,
        username: r.updated_by_username,
        name: r.updated_by_name,
        surname: r.updated_by_surname,
      }),
    }))

    const lignesById = new Map<string, BonLivraisonLigne>()
    for (const l of lignes) lignesById.set(l.id, l)

    // Allocations
    type AllocationRow = {
      id: string
      bon_livraison_ligne_id: string
      article_id: string
      lot_id: string | null
      lot_code: string | null
      lot_status: string | null
      magasin_id: string | null
      magasin_code: string | null
      emplacement_id: number | null
      emplacement_code: string | null
      location_id: string | null
      stock_level_id: string | null
      stock_batch_id: string | null
      reservation_id: string | null
      reservation_status: string | null
      stock_movement_line_id: string | null
      quantite: string | number
      unite: string | null
      created_at: string
      updated_at: string
      created_by_id: number | null
      created_by_username: string | null
      created_by_name: string | null
      created_by_surname: string | null
      updated_by_id: number | null
      updated_by_username: string | null
      updated_by_name: string | null
      updated_by_surname: string | null
    }

    const allocRes = await db.query<AllocationRow>(
      `
      SELECT
        a.id::text AS id,
        a.bon_livraison_ligne_id::text AS bon_livraison_ligne_id,
        a.article_id::text AS article_id,
        a.lot_id::text AS lot_id,
        lot.lot_code,
        lot.lot_status,
        a.magasin_id::text AS magasin_id,
        COALESCE(magasin.code, magasin.code_magasin)::text AS magasin_code,
        a.emplacement_id::int AS emplacement_id,
        emplacement.code AS emplacement_code,
        a.location_id::text AS location_id,
        a.stock_level_id::text AS stock_level_id,
        a.stock_batch_id::text AS stock_batch_id,
        a.reservation_id::text AS reservation_id,
        reservation.status AS reservation_status,
        a.stock_movement_line_id::text AS stock_movement_line_id,
        a.quantite,
        a.unite,
        a.created_at::text AS created_at,
        a.updated_at::text AS updated_at,
        cb.id AS created_by_id,
        cb.username AS created_by_username,
        cb.name AS created_by_name,
        cb.surname AS created_by_surname,
        ub.id AS updated_by_id,
        ub.username AS updated_by_username,
        ub.name AS updated_by_name,
        ub.surname AS updated_by_surname
      FROM public.bon_livraison_ligne_allocations a
      JOIN public.bon_livraison_ligne l ON l.id = a.bon_livraison_ligne_id
      LEFT JOIN public.lots lot ON lot.id = a.lot_id
      LEFT JOIN public.magasins magasin ON magasin.id = a.magasin_id
      LEFT JOIN public.emplacements emplacement ON emplacement.id = a.emplacement_id
      LEFT JOIN public.stock_reservations reservation ON reservation.id = a.reservation_id
      LEFT JOIN users cb ON cb.id = a.created_by
      LEFT JOIN users ub ON ub.id = a.updated_by
      WHERE l.bon_livraison_id = $1::uuid
      ORDER BY a.created_at ASC, a.id ASC
      `,
      [id]
    )

    for (const r of allocRes.rows) {
      const alloc: BonLivraisonLigneAllocation = {
        id: r.id,
        bon_livraison_ligne_id: r.bon_livraison_ligne_id,
        article_id: r.article_id,
        lot_id: r.lot_id,
        lot_code: r.lot_code,
        lot_status: r.lot_status,
        magasin_id: r.magasin_id,
        magasin_code: r.magasin_code,
        emplacement_id: r.emplacement_id,
        emplacement_code: r.emplacement_code,
        location_id: r.location_id,
        stock_level_id: r.stock_level_id,
        stock_batch_id: r.stock_batch_id,
        reservation_id: r.reservation_id,
        reservation_status: r.reservation_status,
        stock_movement_line_id: r.stock_movement_line_id,
        quantite: toFloat(r.quantite, "bon_livraison_ligne_allocations.quantite"),
        unite: r.unite,
        created_at: r.created_at,
        updated_at: r.updated_at,
        created_by: mapUserLite({
          id: r.created_by_id,
          username: r.created_by_username,
          name: r.created_by_name,
          surname: r.created_by_surname,
        }),
        updated_by: mapUserLite({
          id: r.updated_by_id,
          username: r.updated_by_username,
          name: r.updated_by_name,
          surname: r.updated_by_surname,
        }),
      }

      const line = lignesById.get(alloc.bon_livraison_ligne_id)
      if (line) line.allocations.push(alloc)
    }

    // Documents
    type DocRow = {
      id: string
      bon_livraison_id: string
      document_id: string
      type: string | null
      version: number
      created_at: string
      uploaded_by_id: number | null
      uploaded_by_username: string | null
      uploaded_by_name: string | null
      uploaded_by_surname: string | null
      document_name: string | null
      document_type: string | null
      checksum_sha256: string | null
      file_size_bytes: number | null
      mime_type: string | null
    }

    const docsRes = await db.query<DocRow>(
      `
      SELECT
        d.id::text AS id,
        d.bon_livraison_id::text AS bon_livraison_id,
        d.document_id::text AS document_id,
        d.type,
        d.version,
        d.created_at::text AS created_at,
        u.id AS uploaded_by_id,
        u.username AS uploaded_by_username,
        u.name AS uploaded_by_name,
        u.surname AS uploaded_by_surname,
        dc.document_name,
        dc.type AS document_type,
        d.checksum_sha256,
        d.file_size_bytes::float8 AS file_size_bytes,
        d.mime_type
      FROM bon_livraison_documents d
      LEFT JOIN documents_clients dc ON dc.id = d.document_id
      LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.bon_livraison_id = $1::uuid
      ORDER BY d.created_at DESC, d.id DESC
      `,
      [id]
    )
    const documents: BonLivraisonDocument[] = docsRes.rows.map((r: DocRow) => ({
      id: r.id,
      bon_livraison_id: r.bon_livraison_id,
      document_id: r.document_id,
      type: r.type,
      version: r.version,
      created_at: r.created_at,
      uploaded_by: mapUserLite({
        id: r.uploaded_by_id,
        username: r.uploaded_by_username,
        name: r.uploaded_by_name,
        surname: r.uploaded_by_surname,
      }),
      document_name: r.document_name,
      document_type: r.document_type,
      checksum_sha256: r.checksum_sha256,
      file_size_bytes: r.file_size_bytes,
      mime_type: r.mime_type,
    }))

    // Events
    type EventRow = {
      id: string
      bon_livraison_id: string
      event_type: string
      old_values: unknown | null
      new_values: unknown | null
      created_at: string
      user_id: number | null
      username: string | null
      name: string | null
      surname: string | null
    }

    const eventsRes = await db.query<EventRow>(
      `
      SELECT
        e.id::text AS id,
        e.bon_livraison_id::text AS bon_livraison_id,
        e.event_type,
        e.old_values,
        e.new_values,
        e.created_at::text AS created_at,
        u.id AS user_id,
        u.username,
        u.name,
        u.surname
      FROM bon_livraison_event_log e
      LEFT JOIN users u ON u.id = e.user_id
      WHERE e.bon_livraison_id = $1::uuid
      ORDER BY e.created_at DESC, e.id DESC
      `,
      [id]
    )

    const events: BonLivraisonEventLog[] = eventsRes.rows.map((r: EventRow) => ({
      id: r.id,
      bon_livraison_id: r.bon_livraison_id,
      event_type: r.event_type,
      old_values: r.old_values ?? null,
      new_values: r.new_values ?? null,
      user: mapUserLite({ id: r.user_id, username: r.username, name: r.name, surname: r.surname }),
      created_at: r.created_at,
    }))

    const proofs = await repoListLivraisonProofs(id, db)

    return { bon_livraison, lignes, documents, proofs, events }
  } finally {
    db.release()
  }
}

async function insertEvent(
  client: PoolClient,
  params: {
    bon_livraison_id: string
    event_type: string
    user_id: number | null
    old_values?: unknown | null
    new_values?: unknown | null
  }
) {
  const inserted = await client.query<{ id: string; created_at: string }>(
    `
    INSERT INTO bon_livraison_event_log (bon_livraison_id, event_type, old_values, new_values, user_id)
    VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5)
    RETURNING id::text AS id, created_at::text AS created_at
    `,
    [
      params.bon_livraison_id,
      params.event_type,
      params.old_values === undefined ? null : JSON.stringify(params.old_values),
      params.new_values === undefined ? null : JSON.stringify(params.new_values),
      params.user_id,
    ]
  )
  const event = inserted.rows[0]
  if (!event) throw new Error("Failed to persist livraison event")
  await enqueueEntityChanged(client, {
    entityType: "BON_LIVRAISON",
    entityId: params.bon_livraison_id,
    action: params.event_type === "CREATED"
      ? "created"
      : params.event_type.includes("STATUS") || params.event_type.includes("SHIPMENT")
        ? "status_changed"
        : "updated",
    module: "livraisons",
    at: event.created_at,
    invalidateKeys: ["livraisons:list", `livraisons:detail:${params.bon_livraison_id}`],
  }, { deduplicationKey: `livraison-event:${event.id}` })
}

type InsertLineInput = Pick<CreateLivraisonLineBodyDTO, "designation" | "quantite"> &
  Partial<Pick<CreateLivraisonLineBodyDTO, "ordre" | "code_piece" | "unite" | "commande_ligne_id" | "delai_client">>

async function insertLines(client: PoolClient, bonLivraisonId: string, lignes: InsertLineInput[], userId: number) {
  if (!lignes.length) return

  const params: unknown[] = [bonLivraisonId]
  const valuesSql: string[] = []

  lignes.forEach((l: InsertLineInput, idx: number) => {
    const baseIndex = params.length
    const ordre = typeof l.ordre === "number" ? l.ordre : idx + 1
    params.push(
      ordre,
      l.designation,
      l.code_piece ?? null,
      l.quantite,
      l.unite ?? null,
      l.commande_ligne_id ?? null,
      l.delai_client ?? null,
      userId,
      userId
    )
    const placeholders = Array.from({ length: 9 }, (_, j) => `$${baseIndex + 1 + j}`).join(",")
    valuesSql.push(`($1::uuid,${placeholders})`)
  })

  await client.query(
    `
    INSERT INTO bon_livraison_ligne (
      bon_livraison_id,
      ordre,
      designation,
      code_piece,
      quantite,
      unite,
      commande_ligne_id,
      delai_client,
      created_by,
      updated_by
    ) VALUES ${valuesSql.join(",")}
    `,
    params
  )
}

export async function repoCreateLivraison(input: CreateLivraisonBodyDTO, userId: number): Promise<{ id: string }> {
  const db = await pool.connect()
  return withRealtimeOutboxTransaction(db, async (db) => {
    const seqRes = await db.query<{ n: string }>(`SELECT nextval('public.bon_livraison_no_seq')::text AS n`)
    const raw = seqRes.rows[0]?.n
    const n = raw ? Number(raw) : NaN
    if (!Number.isFinite(n)) throw new Error("Failed to reserve bon_livraison number")
    const numero = String(`BL-${String(n).padStart(8, "0")}`).slice(0, 30)
    const statut: BonLivraisonStatut = "DRAFT"

    let id: string

    try {
      const ins = await db.query<{ id: string }>(
        `
        INSERT INTO bon_livraison (
          numero,
          client_id,
          commande_id,
          affaire_id,
          adresse_livraison_id,
          statut,
          date_creation,
          transporteur,
          tracking_number,
          commentaire_interne,
          commentaire_client,
          created_by,
          updated_by
        ) VALUES (
          $1,$2,$3,$4,$5::uuid,$6,$7::date,$8,$9,$10,$11,$12,$12
        )
        RETURNING id::text AS id
        `,
        [
          numero,
          input.client_id,
          input.commande_id ?? null,
          input.affaire_id ?? null,
          input.adresse_livraison_id ?? null,
          statut,
          input.date_creation ?? new Date().toISOString().slice(0, 10),
          input.transporteur ?? null,
          input.tracking_number ?? null,
          input.commentaire_interne ?? null,
          input.commentaire_client ?? null,
          userId,
        ]
      )

      id = ins.rows[0]?.id ?? ""
      if (!id) throw new Error("Failed to create bon_livraison")
    } catch (err) {
      const { code, constraint } = getPgErrorInfo(err)
      if (code === "23505" && constraint === "bon_livraison_numero_key") {
        throw new HttpError(409, "BON_LIVRAISON_NUMERO_EXISTS", "Bon de livraison numero already exists")
      }
      throw err
    }

    await insertLines(db, id, (input.lignes ?? []) as InsertLineInput[], userId)

    await insertEvent(db, {
      bon_livraison_id: id,
      event_type: "CREATED",
      user_id: userId,
      new_values: {
        id,
        numero,
        statut,
        client_id: input.client_id,
        commande_id: input.commande_id ?? null,
        affaire_id: input.affaire_id ?? null,
        adresse_livraison_id: input.adresse_livraison_id ?? null,
      },
    })

    return { id }
  })
}

export async function repoUpdateLivraisonHeader(id: string, patch: UpdateLivraisonBodyDTO, userId: number): Promise<{ id: string } | null> {
  const db = await pool.connect()
  return withRealtimeOutboxTransaction(db, async (db) => {
    const current = await getHeader(db, id, { forUpdate: true })
    if (!current) {
      return null
    }
    if (current.statut !== "DRAFT" && current.statut !== "READY") {
      throw new HttpError(
        409,
        "LOCKED",
        `Update is not allowed when statut=${current.statut}`
      )
    }

    const fields: string[] = []
    const values: unknown[] = []
    const push = (v: unknown) => {
      values.push(v)
      return `$${values.length}`
    }

    const oldValues: Partial<Record<keyof UpdateLivraisonBodyDTO, unknown>> = {}
    const newValues: Partial<Record<keyof UpdateLivraisonBodyDTO, unknown>> = {}

    const readOldValue = (key: keyof UpdateLivraisonBodyDTO): unknown => {
      switch (key) {
        case "commande_id":
          return current.commande_id ? toInt(current.commande_id, "bon_livraison.commande_id") : null
        case "affaire_id":
          return current.affaire_id ? toInt(current.affaire_id, "bon_livraison.affaire_id") : null
        case "adresse_livraison_id":
          return current.adresse_livraison_id
        case "date_creation":
          return current.date_creation
        case "date_expedition":
          return current.date_expedition
        case "date_livraison":
          return current.date_livraison
        case "transporteur":
          return current.transporteur
        case "tracking_number":
          return current.tracking_number
        case "commentaire_interne":
          return current.commentaire_interne
        case "commentaire_client":
          return current.commentaire_client
        case "reception_nom_signataire":
          return current.reception_nom_signataire
        case "reception_date_signature":
          return current.reception_date_signature
        default:
          return null
      }
    }

    const setIfDefined = <K extends keyof UpdateLivraisonBodyDTO>(key: K, sql: string, cast?: string) => {
      const v = patch[key]
      if (v === undefined) return
      oldValues[key] = readOldValue(key)
      newValues[key] = v ?? null
      const p = push(v ?? null)
      fields.push(`${sql} = ${p}${cast ?? ""}`)
    }

    setIfDefined("commande_id", "commande_id")
    setIfDefined("affaire_id", "affaire_id")
    setIfDefined("adresse_livraison_id", "adresse_livraison_id", "::uuid")
    setIfDefined("date_creation", "date_creation", "::date")
    setIfDefined("date_expedition", "date_expedition", "::date")
    setIfDefined("date_livraison", "date_livraison", "::date")
    setIfDefined("transporteur", "transporteur")
    setIfDefined("tracking_number", "tracking_number")
    setIfDefined("commentaire_interne", "commentaire_interne")
    setIfDefined("commentaire_client", "commentaire_client")
    setIfDefined("reception_nom_signataire", "reception_nom_signataire")
    setIfDefined("reception_date_signature", "reception_date_signature", "::timestamptz")

    if (fields.length === 0) {
      return { id }
    }

    fields.push(`updated_at = now()`)
    fields.push(`updated_by = ${push(userId)}`)

    await db.query(`UPDATE bon_livraison SET ${fields.join(", ")} WHERE id = ${push(id)}::uuid`, values)

    await insertEvent(db, {
      bon_livraison_id: id,
      event_type: "UPDATED",
      user_id: userId,
      old_values: oldValues,
      new_values: newValues,
    })

    return { id }
  })
}

export async function repoAddLivraisonLine(
  bonLivraisonId: string,
  input: CreateLivraisonLineBodyDTO,
  userId: number
): Promise<{ lineId: string }> {
  const db = await pool.connect()
  return withRealtimeOutboxTransaction(db, async (db) => {
    const current = await getHeader(db, bonLivraisonId, { forUpdate: true })
    if (!current) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
    if (current.statut !== "DRAFT") {
      throw new HttpError(409, "LOCKED", "Add line is only allowed when statut=DRAFT")
    }

    const ordreRes = await db.query<{ next_ordre: number }>(
      `SELECT COALESCE(MAX(ordre), 0)::int + 1 AS next_ordre FROM bon_livraison_ligne WHERE bon_livraison_id = $1::uuid`,
      [bonLivraisonId]
    )
    const ordre = typeof input.ordre === "number" ? input.ordre : ordreRes.rows[0]?.next_ordre ?? 1

    const ins = await db.query<{ id: string }>(
      `
      INSERT INTO bon_livraison_ligne (
        bon_livraison_id,
        ordre,
        designation,
        code_piece,
        quantite,
        unite,
        commande_ligne_id,
        delai_client,
        created_by,
        updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id::text AS id
      `,
      [
        bonLivraisonId,
        ordre,
        input.designation,
        input.code_piece ?? null,
        input.quantite,
        input.unite ?? null,
        input.commande_ligne_id ?? null,
        input.delai_client ?? null,
        userId,
        userId,
      ]
    )
    const lineId = ins.rows[0]?.id
    if (!lineId) throw new Error("Failed to insert bon_livraison_ligne")

    await db.query(`UPDATE bon_livraison SET updated_at = now(), updated_by = $2 WHERE id = $1::uuid`, [bonLivraisonId, userId])

    await insertEvent(db, {
      bon_livraison_id: bonLivraisonId,
      event_type: "LINE_ADDED",
      user_id: userId,
      new_values: { line_id: lineId, ordre, ...input },
    })

    return { lineId }
  })
}

export async function repoUpdateLivraisonLine(
  bonLivraisonId: string,
  lineId: string,
  patch: UpdateLivraisonLineBodyDTO,
  userId: number
): Promise<{ lineId: string } | null> {
  const db = await pool.connect()
  return withRealtimeOutboxTransaction(db, async (db) => {
    const header = await getHeader(db, bonLivraisonId, { forUpdate: true })
    if (!header) {
      return null
    }
    if (header.statut !== "DRAFT") {
      throw new HttpError(409, "LOCKED", "Update line is only allowed when statut=DRAFT")
    }

    const currentRes = await db.query<{
      id: string
      ordre: number
      designation: string
      code_piece: string | null
      quantite: string | number
      unite: string | null
      commande_ligne_id: string | null
      delai_client: string | null
    }>(
      `
      SELECT
        id::text AS id,
        ordre,
        designation,
        code_piece,
        quantite,
        unite,
        commande_ligne_id::text AS commande_ligne_id,
        delai_client
      FROM bon_livraison_ligne
      WHERE bon_livraison_id = $1::uuid AND id = $2::uuid
      FOR UPDATE
      `,
      [bonLivraisonId, lineId]
    )
    const current = currentRes.rows[0] ?? null
    if (!current) {
      return null
    }

    const fields: string[] = []
    const values: unknown[] = []
    const push = (v: unknown) => {
      values.push(v)
      return `$${values.length}`
    }

    const oldValues: Partial<Record<keyof UpdateLivraisonLineBodyDTO, unknown>> = {}
    const newValues: Partial<Record<keyof UpdateLivraisonLineBodyDTO, unknown>> = {}

    const readOldValue = (key: keyof UpdateLivraisonLineBodyDTO): unknown => {
      switch (key) {
        case "ordre":
          return current.ordre
        case "designation":
          return current.designation
        case "code_piece":
          return current.code_piece
        case "quantite":
          return toFloat(current.quantite, "bon_livraison_ligne.quantite")
        case "unite":
          return current.unite
        case "commande_ligne_id":
          return current.commande_ligne_id ? toInt(current.commande_ligne_id, "bon_livraison_ligne.commande_ligne_id") : null
        case "delai_client":
          return current.delai_client
        default:
          return null
      }
    }

    const setIfDefined = <K extends keyof UpdateLivraisonLineBodyDTO>(key: K, sql: string) => {
      const v = patch[key]
      if (v === undefined) return
      oldValues[key] = readOldValue(key)
      newValues[key] = v ?? null
      fields.push(`${sql} = ${push(v ?? null)}`)
    }

    setIfDefined("ordre", "ordre")
    setIfDefined("designation", "designation")
    setIfDefined("code_piece", "code_piece")
    setIfDefined("quantite", "quantite")
    setIfDefined("unite", "unite")
    setIfDefined("commande_ligne_id", "commande_ligne_id")
    setIfDefined("delai_client", "delai_client")

    if (fields.length === 0) {
      return { lineId }
    }

    fields.push(`updated_at = now()`)
    fields.push(`updated_by = ${push(userId)}`)

    await db.query(
      `UPDATE bon_livraison_ligne SET ${fields.join(", ")} WHERE bon_livraison_id = ${push(bonLivraisonId)}::uuid AND id = ${push(lineId)}::uuid`,
      values
    )

    await db.query(`UPDATE bon_livraison SET updated_at = now(), updated_by = $2 WHERE id = $1::uuid`, [bonLivraisonId, userId])

    await insertEvent(db, {
      bon_livraison_id: bonLivraisonId,
      event_type: "LINE_UPDATED",
      user_id: userId,
      old_values: { line_id: lineId, ...oldValues },
      new_values: { line_id: lineId, ...newValues },
    })

    return { lineId }
  })
}

export async function repoDeleteLivraisonLine(bonLivraisonId: string, lineId: string, userId: number): Promise<boolean> {
  const db = await pool.connect()
  return withRealtimeOutboxTransaction(db, async (db) => {
    const header = await getHeader(db, bonLivraisonId, { forUpdate: true })
    if (!header) {
      return false
    }
    if (header.statut !== "DRAFT") {
      throw new HttpError(409, "LOCKED", "Delete line is only allowed when statut=DRAFT")
    }

    const delRes = await db.query(`DELETE FROM bon_livraison_ligne WHERE bon_livraison_id = $1::uuid AND id = $2::uuid`, [bonLivraisonId, lineId])
    const ok = (delRes.rowCount ?? 0) > 0

    if (ok) {
      await db.query(`UPDATE bon_livraison SET updated_at = now(), updated_by = $2 WHERE id = $1::uuid`, [bonLivraisonId, userId])
      await insertEvent(db, {
        bon_livraison_id: bonLivraisonId,
        event_type: "LINE_REMOVED",
        user_id: userId,
        old_values: { line_id: lineId },
      })
    }

    return ok
  })
}

export async function repoCreateLivraisonLineAllocation(
  bonLivraisonId: string,
  lineId: string,
  input: CreateLivraisonAllocationBodyDTO,
  userId: number
): Promise<{ allocationId: string }> {
  const db = await pool.connect()
  return withRealtimeOutboxTransaction(db, async (db) => {
    const header = await getHeader(db, bonLivraisonId, { forUpdate: true })
    if (!header) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
    if (header.statut !== "DRAFT") {
      throw new HttpError(409, "ALLOCATION_LOCKED", "Les allocations ne sont modifiables qu’au statut DRAFT.")
    }

    const lineRes = await db.query<{
      id: string
      quantite: number
      commande_article_id: string | null
    }>(
      `
        SELECT
          line.id::text AS id,
          line.quantite::float8 AS quantite,
          commande_line.article_id::text AS commande_article_id
        FROM public.bon_livraison_ligne line
        LEFT JOIN public.commande_ligne commande_line ON commande_line.id = line.commande_ligne_id
        WHERE line.bon_livraison_id = $1::uuid
          AND line.id = $2::uuid
        FOR UPDATE OF line
      `,
      [bonLivraisonId, lineId]
    )
    const line = lineRes.rows[0] ?? null
    if (!line) throw new HttpError(404, "LINE_NOT_FOUND", "Bon de livraison line not found")
    const allocated = await db.query<{ quantity: number }>(
      `
        SELECT COALESCE(SUM(quantite), 0)::float8 AS quantity
        FROM public.bon_livraison_ligne_allocations
        WHERE bon_livraison_ligne_id = $1::uuid
      `,
      [lineId]
    )
    const allocatedQuantity = Number(allocated.rows[0]?.quantity ?? 0)
    if (
      line.commande_article_id &&
      line.commande_article_id !== input.article_id
    ) {
      throw new HttpError(
        409,
        "LINE_ARTICLE_MISMATCH",
        "L’article alloué ne correspond pas à l’article de la ligne de commande."
      )
    }
    if (allocatedQuantity + input.quantite > line.quantite + 1e-9) {
      throw new HttpError(
        409,
        "ALLOCATION_EXCEEDS_LINE",
        "La quantité allouée dépasserait la quantité de la ligne."
      )
    }

    const article = await db.query<{
      stock_managed: boolean
      lot_tracking: boolean
    }>(
      `
        SELECT stock_managed, lot_tracking
        FROM public.articles
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [input.article_id]
    )
    const articleSettings = article.rows[0] ?? null
    if (!articleSettings) {
      throw new HttpError(400, "INVALID_ARTICLE", "Unknown article_id")
    }
    if (!articleSettings.stock_managed) {
      throw new HttpError(409, "ARTICLE_NOT_STOCK_MANAGED", "Cet article n’est pas géré en stock.")
    }
    if (articleSettings.lot_tracking && !input.lot_id) {
      throw new HttpError(409, "LOT_REQUIRED", "Un lot est obligatoire pour cet article.")
    }

    if (input.lot_id) {
      const lot = await db.query<{ article_id: string; lot_status: string | null }>(
        `SELECT article_id::text AS article_id, lot_status FROM public.lots WHERE id = $1::uuid`,
        [input.lot_id]
      )
      const row = lot.rows[0] ?? null
      const lotArticleId = row?.article_id
      if (!lotArticleId) {
        throw new HttpError(400, "INVALID_LOT", "Unknown lot_id")
      }
      if (lotArticleId !== input.article_id) {
        throw new HttpError(400, "LOT_ARTICLE_MISMATCH", "lot_id does not belong to article_id")
      }

      const lotStatus = row?.lot_status ?? "LIBERE"
      if (lotStatus === "BLOQUE" || lotStatus === "EN_ATTENTE" || lotStatus === "QUARANTAINE") {
        throw new HttpError(409, "LOT_NOT_CONSUMABLE", `Ce lot n'est pas consommable (statut: ${lotStatus})`)
      }
    }

    const source = await getStockEmplacementMapping(
      db,
      input.magasin_id,
      input.emplacement_id,
      "src"
    )
    const stockLevel = await db.query<{ id: string }>(
      `
        SELECT id::text AS id
        FROM public.stock_levels
        WHERE article_id = $1::uuid
          AND location_id = $2::uuid
        LIMIT 1
      `,
      [input.article_id, source.location_id]
    )
    const stockLevelId = stockLevel.rows[0]?.id
    if (!stockLevelId) {
      throw new HttpError(
        409,
        "STOCK_LEVEL_MISSING",
        "Aucun stock n’existe pour cet article sur l’emplacement choisi."
      )
    }

    let stockBatchId: string | null = null
    if (input.lot_id) {
      const stockBatch = await db.query<{ id: string }>(
        `
          SELECT batch.id::text AS id
          FROM public.stock_batches batch
          JOIN public.lots lot ON lot.id = batch.lot_id
          WHERE batch.stock_level_id = $1::uuid
            AND batch.lot_id = $2::uuid
            AND lot.article_id = $3::uuid
          LIMIT 1
        `,
        [stockLevelId, input.lot_id, input.article_id]
      )
      stockBatchId = stockBatch.rows[0]?.id ?? null
      if (!stockBatchId) {
        throw new HttpError(
          409,
          "STOCK_BATCH_MISSING",
          "Le lot ne possède pas de stock sur l’emplacement choisi."
        )
      }
    }

    const states = await lockStockStates(db, [
      { stock_level_id: stockLevelId, stock_batch_id: stockBatchId },
    ])
    const state = states.get(
      stockTargetKey({ stock_level_id: stockLevelId, stock_batch_id: stockBatchId })
    )
    if (!state) throw new Error("Locked allocation stock state missing")
    assertStockConsumptionAllowed(state, { movement_type: "RESERVE", qty: input.quantite })

    const ins = await db.query<{ id: string }>(
      `
        INSERT INTO public.bon_livraison_ligne_allocations (
          bon_livraison_ligne_id,
          article_id,
          lot_id,
          magasin_id,
          emplacement_id,
          location_id,
          stock_level_id,
          stock_batch_id,
          reservation_id,
          stock_movement_line_id,
          quantite,
          unite,
          created_by,
          updated_by
        ) VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          $5::bigint,
          $6::uuid,
          $7::uuid,
          $8::uuid,
          NULL,
          NULL,
          $9,
          $10,
          $11,
          $11
        )
        RETURNING id::text AS id
      `,
      [
        lineId,
        input.article_id,
        input.lot_id ?? null,
        input.magasin_id,
        input.emplacement_id,
        source.location_id,
        stockLevelId,
        stockBatchId,
        input.quantite,
        input.unite ?? null,
        userId,
      ]
    )
    const allocationId = ins.rows[0]?.id
    if (!allocationId) throw new Error("Failed to insert allocation")

    await db.query(`UPDATE bon_livraison SET updated_at = now(), updated_by = $2 WHERE id = $1::uuid`, [bonLivraisonId, userId])

    await insertEvent(db, {
      bon_livraison_id: bonLivraisonId,
      event_type: "ALLOCATION_ADDED",
      user_id: userId,
      new_values: {
        allocation_id: allocationId,
        line_id: lineId,
        article_id: input.article_id,
        lot_id: input.lot_id ?? null,
        magasin_id: input.magasin_id,
        emplacement_id: input.emplacement_id,
        location_id: source.location_id,
        stock_level_id: stockLevelId,
        stock_batch_id: stockBatchId,
        quantite: input.quantite,
        unite: input.unite ?? null,
      },
    })

    return { allocationId }
  })
}

export async function repoDeleteLivraisonLineAllocation(
  bonLivraisonId: string,
  lineId: string,
  allocationId: string,
  userId: number
): Promise<boolean> {
  const db = await pool.connect()
  return withRealtimeOutboxTransaction(db, async (db) => {
    const header = await getHeader(db, bonLivraisonId, { forUpdate: true })
    if (!header) {
      return false
    }
    if (header.statut !== "DRAFT") {
      throw new HttpError(
        409,
        "LOCKED",
        "Delete allocation is only allowed when statut=DRAFT"
      )
    }

    const lockRes = await db.query<{ stock_movement_line_id: string | null }>(
      `
        SELECT a.stock_movement_line_id::text AS stock_movement_line_id
        FROM public.bon_livraison_ligne_allocations a
        JOIN public.bon_livraison_ligne l ON l.id = a.bon_livraison_ligne_id
        WHERE a.id = $1::uuid
          AND a.bon_livraison_ligne_id = $2::uuid
          AND l.bon_livraison_id = $3::uuid
        FOR UPDATE
      `,
      [allocationId, lineId, bonLivraisonId]
    )
    const locked = lockRes.rows[0] ?? null
    if (!locked) {
      return false
    }
    if (locked.stock_movement_line_id) {
      throw new HttpError(409, "ALLOCATION_LOCKED", "Allocation is linked to a stock movement line")
    }

    const delRes = await db.query(
      `DELETE FROM public.bon_livraison_ligne_allocations WHERE id = $1::uuid AND bon_livraison_ligne_id = $2::uuid`,
      [allocationId, lineId]
    )
    const ok = (delRes.rowCount ?? 0) > 0

    if (ok) {
      await db.query(`UPDATE bon_livraison SET updated_at = now(), updated_by = $2 WHERE id = $1::uuid`, [bonLivraisonId, userId])
      await insertEvent(db, {
        bon_livraison_id: bonLivraisonId,
        event_type: "ALLOCATION_REMOVED",
        user_id: userId,
        old_values: { allocation_id: allocationId, line_id: lineId },
      })
    }

    return ok
  })
}

async function repoUpdateLivraisonStatusLegacy(
  bonLivraisonId: string,
  statut: BonLivraisonStatut,
  userId: number,
  meta?: { commentaire?: string | null }
): Promise<{ id: string; statut: BonLivraisonStatut }> {
  const db = await pool.connect()
  return withRealtimeOutboxTransaction(db, async (db) => {
    const current = await getHeader(db, bonLivraisonId, { forUpdate: true })
    if (!current) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")

    const oldStatut = current.statut

     const shouldShip = oldStatut === "READY" && statut === "SHIPPED"
     const issuedMovementIds: string[] = []

     if (shouldShip) {
       const shipping = await getDefaultShippingLocationSetting(db)
       const shippingMap = await getEmplacementMapping(db, shipping.magasin_id, shipping.emplacement_id, "shipping")

       const linesRes = await db.query<{ id: string; ordre: number; designation: string }>(
         `
           SELECT id::text AS id, ordre, designation
           FROM public.bon_livraison_ligne
           WHERE bon_livraison_id = $1::uuid
           ORDER BY ordre ASC, id ASC
         `,
         [bonLivraisonId]
       )
       const blLines = linesRes.rows

       type ShipAllocRow = {
         id: string
         bon_livraison_ligne_id: string
         article_id: string
         lot_id: string | null
         lot_article_id: string | null
         lot_status: string | null
         stock_movement_line_id: string | null
         reservation_id: string | null
         reservation_status: string | null
         reservation_qty: string | number | null
         quantite: string | number
         unite: string | null
       }

       const allocRes = await db.query<ShipAllocRow>(
         `
           SELECT
             a.id::text AS id,
             a.bon_livraison_ligne_id::text AS bon_livraison_ligne_id,
             a.article_id::text AS article_id,
             a.lot_id::text AS lot_id,
             lt.article_id::text AS lot_article_id,
             lt.lot_status,
             a.stock_movement_line_id::text AS stock_movement_line_id,
             a.reservation_id::text AS reservation_id,
             reservation.status::text AS reservation_status,
             reservation.qty_reserved AS reservation_qty,
             a.quantite,
             a.unite
           FROM public.bon_livraison_ligne_allocations a
           JOIN public.bon_livraison_ligne l ON l.id = a.bon_livraison_ligne_id
           LEFT JOIN public.lots lt ON lt.id = a.lot_id
           LEFT JOIN public.stock_reservations reservation ON reservation.id = a.reservation_id
           WHERE l.bon_livraison_id = $1::uuid
           ORDER BY a.created_at ASC, a.id ASC
         `,
         [bonLivraisonId]
       )
       const allocRows = allocRes.rows

       const blocked = allocRows.find((a) => Boolean(a.lot_id) && ["BLOQUE", "EN_ATTENTE", "QUARANTAINE"].includes(a.lot_status ?? "LIBERE"))
       if (blocked?.lot_id) {
         throw new HttpError(409, "LOT_NOT_CONSUMABLE", "Expedition impossible : un lot alloue n'est pas consommable")
       }

       const allocsByLineId = new Map<string, ShipAllocRow[]>()
       for (const a of allocRows) {
         const list = allocsByLineId.get(a.bon_livraison_ligne_id) ?? []
         list.push(a)
         allocsByLineId.set(a.bon_livraison_ligne_id, list)
       }

       const missingLines = blLines.filter((l) => !(allocsByLineId.get(l.id)?.length ?? 0))
       if (missingLines.length) {
         throw new HttpError(
           400,
           "ALLOCATIONS_REQUIRED",
           "Allocations are required before shipping. Add allocations for each livraison line."
         )
       }

       type AllocItem = {
         allocation_id: string
         bon_livraison_ligne_id: string
         article_id: string
         lot_id: string | null
         quantite: number
         unite: string | null
         reservation_id: string | null
         reservation_status: string | null
         reservation_qty: string | number | null
       }

       type IssueGroup = {
         article_id: string
         lot_id: string | null
         unite: string | null
         items: AllocItem[]
       }
       const groups = new Map<string, IssueGroup>()

       for (const a of allocRows) {
         if (a.stock_movement_line_id) {
           throw new HttpError(409, "ALLOCATION_LOCKED", "Some allocations are already linked to stock movements")
         }

         if (a.lot_id && a.lot_article_id && a.lot_article_id !== a.article_id) {
           throw new HttpError(400, "LOT_ARTICLE_MISMATCH", "Allocation lot_id does not belong to allocation article_id")
         }

         const qty = toFloat(a.quantite, "bon_livraison_ligne_allocations.quantite")
         if (!Number.isFinite(qty) || qty <= 0) {
           throw new HttpError(400, "INVALID_QTY", "Allocation quantite must be > 0")
         }

         const unite = typeof a.unite === "string" && a.unite.trim() ? a.unite.trim() : null
         const key = `${a.article_id}:${a.lot_id ?? ""}`
         const g = groups.get(key) ?? { article_id: a.article_id, lot_id: a.lot_id ?? null, unite, items: [] }
         if (unite && g.unite && unite !== g.unite) {
           throw new HttpError(409, "UNIT_MISMATCH", "All allocations in the same stock movement must use the same unit")
         }
         if (!g.unite && unite) g.unite = unite

         g.items.push({
           allocation_id: a.id,
           bon_livraison_ligne_id: a.bon_livraison_ligne_id,
           article_id: a.article_id,
           lot_id: a.lot_id ?? null,
           quantite: qty,
           unite,
           reservation_id: a.reservation_id,
           reservation_status: a.reservation_status,
           reservation_qty: a.reservation_qty,
         })
         groups.set(key, g)
       }

       for (const g of groups.values()) {
         const totalQty = g.items.reduce((acc, it) => acc + it.quantite, 0)
         if (!Number.isFinite(totalQty) || totalQty <= 0) {
           throw new HttpError(400, "INVALID_QTY", "Invalid allocated qty")
         }

         // Legacy status-transition shipping posts its own OUT movement rather
         // than delegating to the newer shipment repository. It therefore
         // needs the same transaction-bound Quality gate before any stock
         // level/batch lock or movement number is consumed.
         const reservationPlan = buildLegacyShipmentReservationPlan(g.items)
         // Reservation-backed quantities are already represented in the
         // Quality commitment ledger. Validate current eligibility with zero
         // incremental demand; only allocations without an ACTIVE reservation
         // are a direct release-capacity debit.
         if (g.lot_id && reservationPlan.committed_qty > 0) {
           await assertOperationalLotQualityEligibility({
             client: db,
             lotId: g.lot_id,
             qty: 0,
             unit: g.unite,
             purpose: "RESERVE",
           })
         }
         const qualityDecision = g.lot_id && reservationPlan.direct_qty > 0
           ? await assertOperationalLotQualityEligibility({
             client: db,
             lotId: g.lot_id,
             qty: reservationPlan.direct_qty,
             unit: g.unite,
             purpose: "RESERVE",
           })
           : null

         const unitId = await resolveUnitIdForArticle(db, g.article_id, g.unite)
         const stockLevelId = await ensureStockLevel(db, {
           article_id: g.article_id,
           unit_id: unitId,
           warehouse_id: shippingMap.warehouse_id,
           location_id: shippingMap.location_id,
           actor_user_id: userId,
         })
         const stockBatchId = g.lot_id ? await ensureStockBatchId(db, { stock_level_id: stockLevelId, lot_id: g.lot_id }) : null

         const movementNo = await reserveStockMovementNo(db)
         const idempotencyKey = `bon_livraison:${bonLivraisonId}:ship:${g.article_id}:${g.lot_id ?? "none"}`
         const effectiveAt = new Date().toISOString()

         const ins = await db.query<{ id: string }>(
           `
             INSERT INTO public.stock_movements (
               movement_no,
               movement_type,
               status,
               article_id,
               stock_level_id,
               stock_batch_id,
               qty,
               currency,
               effective_at,
               source_document_type,
               source_document_id,
               reason_code,
               notes,
               idempotency_key,
               user_id,
               created_by,
               updated_by
             )
              VALUES ($1,'OUT'::public.movement_type,'DRAFT',$2::uuid,$3::uuid,$4::uuid,$5,'EUR',$6,$7,$8,$9,$10,$11,$12,$12,$12)
              RETURNING id::text AS id
            `,
           [
             movementNo,
             g.article_id,
             stockLevelId,
             stockBatchId,
             totalQty,
             effectiveAt,
             "BON_LIVRAISON",
             bonLivraisonId,
             "BON_LIVRAISON_SHIPMENT",
             `Shipment for ${current.numero}`,
             idempotencyKey,
             userId,
           ]
         )
         const movementId = ins.rows[0]?.id
         if (!movementId) throw new Error("Failed to create stock movement")
         issuedMovementIds.push(movementId)

         await insertStockMovementEvent(db, {
           movement_id: movementId,
           event_type: "CREATED",
           old_values: null,
           new_values: {
             status: "DRAFT",
             movement_type: "OUT",
             allocations_count: g.items.length,
             source_document_type: "BON_LIVRAISON",
             source_document_id: bonLivraisonId,
           },
           user_id: userId,
         })

         let lineNo = 1
         for (const it of g.items) {
           const lineIns = await db.query<{ id: string }>(
             `
               INSERT INTO public.stock_movement_lines (
                 movement_id,
                 line_no,
                 article_id,
                 lot_id,
                 qty,
                 unite,
                 src_magasin_id,
                 src_emplacement_id,
                 note,
                 created_by,
                 updated_by
               ) VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7::uuid,$8::bigint,$9,$10,$10)
               RETURNING id::text AS id
             `,
             [
               movementId,
               lineNo,
               it.article_id,
               it.lot_id,
               it.quantite,
               it.unite,
               shipping.magasin_id,
               shipping.emplacement_id,
               `BL ${current.numero} SHIPPED`,
               userId,
             ]
           )
           const stockLineId = lineIns.rows[0]?.id
           if (!stockLineId) throw new Error("Failed to create stock movement line")

           await db.query(
             `
               UPDATE public.bon_livraison_ligne_allocations
               SET stock_movement_line_id = $2::uuid,
                   updated_at = now(),
                   updated_by = $3
               WHERE id = $1::uuid
             `,
             [it.allocation_id, stockLineId, userId]
           )
           lineNo++
         }

         await db.query(
           `
             UPDATE public.stock_movements
             SET status = 'POSTED', posted_at = now(), posted_by = $2, updated_at = now(), updated_by = $2
             WHERE id = $1::uuid
           `,
           [movementId, userId]
         )

         // This legacy path posts the physical OUT itself rather than calling
         // stock.repoPostMovement. It therefore owns the same durable direct
         // consumption write; otherwise every sequential legacy shipment
         // could reuse the same quality-release quantity.
         if (qualityDecision) {
           await recordDirectLotQualityConsumption({
             client: db,
             decision: qualityDecision,
             qty: reservationPlan.direct_qty,
           })
         }

         if (reservationPlan.committed_qty > 0) {
           const reserved = await db.query<{ id: string }>(
             `
               UPDATE public.stock_levels
               SET qty_reserved = qty_reserved - $2,
                   updated_at = now(),
                   updated_by = $3
               WHERE id = $1::uuid
                 AND qty_reserved + 1e-9 >= $2
               RETURNING id::text AS id
             `,
             [stockLevelId, reservationPlan.committed_qty, userId]
           )
           if (!reserved.rows[0]) throw new HttpError(409, "RESERVATION_STOCK_COUNTER_MISMATCH", "Le stock réservé du BL a été modifié concurremment.")
           if (stockBatchId) {
             const batch = await db.query<{ id: string }>(
               `UPDATE public.stock_batches SET qty_reserved = qty_reserved - $2 WHERE id = $1::uuid AND qty_reserved + 1e-9 >= $2 RETURNING id::text AS id`,
               [stockBatchId, reservationPlan.committed_qty]
             )
             if (!batch.rows[0]) throw new HttpError(409, "RESERVATION_STOCK_COUNTER_MISMATCH", "Le lot réservé du BL a été modifié concurremment.")
           }
           const consumed = await db.query<{ id: string }>(
             `
               UPDATE public.stock_reservations
               SET status = 'CONSUMED', consumed_at = now(), consumed_by = $2,
                   consumed_stock_movement_id = $3::uuid, updated_at = now(), updated_by = $2
               WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'
               RETURNING id::text AS id
             `,
             [reservationPlan.reservation_ids, userId, movementId]
           )
           if (consumed.rows.length !== reservationPlan.reservation_ids.length) {
             throw new HttpError(409, "RESERVATION_CONCURRENTLY_CHANGED", "Une réservation du BL a été modifiée concurremment.")
           }
         }

         await insertStockMovementEvent(db, {
           movement_id: movementId,
           event_type: "POSTED",
           old_values: { status: "DRAFT" },
           new_values: { status: "POSTED" },
           user_id: userId,
         })
       }
     }

    await db.query(`UPDATE bon_livraison SET statut = $2, updated_at = now(), updated_by = $3 WHERE id = $1::uuid`, [bonLivraisonId, statut, userId])

    if (statut === "SHIPPED" && !current.date_expedition) {
      await db.query(`UPDATE bon_livraison SET date_expedition = CURRENT_DATE WHERE id = $1::uuid`, [bonLivraisonId])
    }
    if (statut === "DELIVERED" && !current.date_livraison) {
      await db.query(`UPDATE bon_livraison SET date_livraison = CURRENT_DATE WHERE id = $1::uuid`, [bonLivraisonId])
    }

    await insertEvent(db, {
      bon_livraison_id: bonLivraisonId,
      event_type: "STATUS_CHANGED",
      user_id: userId,
      old_values: { statut: oldStatut },
      new_values: { statut, commentaire: meta?.commentaire ?? null },
    })

     if (shouldShip) {
        await insertEvent(db, {
          bon_livraison_id: bonLivraisonId,
          event_type: "SHIPMENT_VALIDATED",
          user_id: userId,
          new_values: {
            stock_movement_ids: issuedMovementIds,
          },
        })

       await repoInsertAuditLog({
         user_id: userId,
         body: {
           event_type: "ACTION",
           action: "livraisons.shipped",
           page_key: "livraisons",
           entity_type: "bon_livraison",
           entity_id: bonLivraisonId,
           path: `/api/v1/livraisons/${bonLivraisonId}/status`,
           client_session_id: null,
           details: {
             bon_livraison_numero: current.numero,
             old_statut: oldStatut,
             new_statut: statut,
             stock_movement_ids: issuedMovementIds,
           },
         },
         ip: null,
         user_agent: null,
         device_type: null,
         os: null,
         browser: null,
         tx: db,
       })
     }

    return { id: bonLivraisonId, statut }
  })
}

export async function repoUpdateLivraisonStatus(
  bonLivraisonId: string,
  statut: BonLivraisonStatut,
  userId: number,
  meta?: { commentaire?: string | null }
): Promise<{ id: string; statut: BonLivraisonStatut }> {
  if (statut === "SHIPPED") {
    throw new HttpError(
      409,
      "SHIPMENT_CONFIRMATION_REQUIRED",
      "Utilisez la confirmation d’expédition avec aperçu et Idempotency-Key."
    )
  }

  const db = await pool.connect()
  return withRealtimeOutboxTransaction(db, async (db) => {
    const current = await getHeader(db, bonLivraisonId, { forUpdate: true })
    if (!current) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
    const cancellationReason = statut === "CANCELLED" ? meta?.commentaire?.trim() ?? "" : ""
    if (statut === "CANCELLED" && !cancellationReason) {
      throw new HttpError(
        422,
        "CANCELLATION_REASON_REQUIRED",
        "Un motif est obligatoire pour annuler un bon de livraison."
      )
    }
    if (current.statut === statut) {
      return { id: bonLivraisonId, statut }
    }
    if (!isLivraisonTransitionAllowed(current.statut, statut)) {
      throw new HttpError(
        409,
        "INVALID_TRANSITION",
        `Invalid transition from ${current.statut} to ${statut}`
      )
    }
    if (current.statut === "DRAFT" && statut === "READY") {
      await prepareLivraisonInTransaction(db, bonLivraisonId, userId)
      return { id: bonLivraisonId, statut: "READY" }
    }

    if (
      (current.statut === "DRAFT" || current.statut === "READY") &&
      statut === "CANCELLED"
    ) {
      await releaseLivraisonReservationsInTransaction(
        db,
        bonLivraisonId,
        userId,
        cancellationReason
      )
    }
    if (current.statut === "SHIPPED" && statut === "DELIVERED") {
      const proof = await db.query<{ count: number }>(
        `
          SELECT COUNT(*)::int AS count
          FROM public.bon_livraison_delivery_proofs
          WHERE bon_livraison_id = $1::uuid
        `,
        [bonLivraisonId]
      )
      if (!proof.rows[0]?.count) {
        throw new HttpError(
          422,
          "DELIVERY_PROOF_REQUIRED",
          "Une preuve de livraison est obligatoire avant de déclarer le BL livré."
        )
      }
    }

    const updated = await db.query(
      `
        UPDATE public.bon_livraison
        SET statut = $2,
            date_livraison = CASE
              WHEN $2 = 'DELIVERED' THEN COALESCE(date_livraison, CURRENT_DATE)
              ELSE date_livraison
            END,
            updated_at = now(),
            updated_by = $3
        WHERE id = $1::uuid
          AND statut = $4
      `,
      [bonLivraisonId, statut, userId, current.statut]
    )
    if ((updated.rowCount ?? 0) !== 1) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Le statut du BL a changé.")
    }
    await insertEvent(db, {
      bon_livraison_id: bonLivraisonId,
      event_type: "STATUS_CHANGED",
      user_id: userId,
      old_values: { statut: current.statut },
      new_values: {
        statut,
        commentaire: statut === "CANCELLED" ? cancellationReason : meta?.commentaire ?? null,
      },
    })
    if (statut === "CANCELLED") {
      await repoInsertAuditLog({
        user_id: userId,
        body: {
          event_type: "ACTION",
          action: "livraisons.cancelled",
          page_key: "livraisons",
          entity_type: "bon_livraison",
          entity_id: bonLivraisonId,
          path: `/api/v1/livraisons/${bonLivraisonId}/status`,
          client_session_id: null,
          details: {
            bon_livraison_numero: current.numero,
            old_statut: current.statut,
            new_statut: statut,
            reason: cancellationReason,
          },
        },
        ip: null,
        user_agent: null,
        device_type: null,
        os: null,
        browser: null,
        tx: db,
      })
    }
    return { id: bonLivraisonId, statut }
  })

}

export async function attachActiveCommandeReservationsToLivraison(
  db: PoolClient,
  bonLivraisonId: string,
  userId: number
): Promise<{ attached: number; fullyAllocated: boolean }> {
  const reservations = await db.query<{
    line_id: string
    commande_ligne_id: number
    line_quantity: number
    affaire_id: number | null
    reservation_id: string
    reservation_quantity: number
    article_id: string
    lot_id: string | null
    location_id: string
    stock_level_id: string
    stock_batch_id: string | null
    magasin_id: string | null
    emplacement_id: number | null
    unite: string | null
  }>(
    `
      SELECT
        delivery_line.id::text AS line_id,
        delivery_line.commande_ligne_id::bigint::int AS commande_ligne_id,
        delivery_line.quantite::float8 AS line_quantity,
        delivery.affaire_id::bigint::int AS affaire_id,
        reservation.id::text AS reservation_id,
        reservation.qty_reserved::float8 AS reservation_quantity,
        reservation.article_id::text AS article_id,
        reservation.lot_id::text AS lot_id,
        reservation.location_id::text AS location_id,
        level.id::text AS stock_level_id,
        reservation.stock_batch_id::text AS stock_batch_id,
        location_map.magasin_id::text AS magasin_id,
        location_map.emplacement_id::bigint::int AS emplacement_id,
        article.unite
      FROM public.bon_livraison_ligne delivery_line
      JOIN public.bon_livraison delivery
        ON delivery.id = delivery_line.bon_livraison_id
      JOIN public.stock_reservations reservation
        ON reservation.commande_ligne_id = delivery_line.commande_ligne_id
       AND reservation.source_type = 'COMMANDE_LIGNE'
       AND reservation.status = 'ACTIVE'
      JOIN public.stock_levels level
        ON level.article_id = reservation.article_id
       AND level.location_id = reservation.location_id
      JOIN public.articles article ON article.id = reservation.article_id
      LEFT JOIN LATERAL (
        SELECT
          emplacement.magasin_id,
          emplacement.id AS emplacement_id
        FROM public.emplacements emplacement
        WHERE emplacement.location_id = reservation.location_id
        ORDER BY emplacement.id
        LIMIT 1
      ) location_map ON TRUE
      WHERE delivery.id = $1::uuid
        AND delivery_line.commande_ligne_id IS NOT NULL
      ORDER BY delivery_line.ordre, reservation.created_at, reservation.id
      FOR UPDATE OF delivery_line, reservation, level
    `,
    [bonLivraisonId]
  )

  const remainingByLine = new Map<string, number>()
  const consumedReservationIds = new Set<string>()
  let attached = 0
  for (const reservation of reservations.rows) {
    // A reservation can appear more than once if a malformed BL contains
    // duplicate lines for the same order line. Never allocate the same locked
    // reservation snapshot twice; leave the duplicate line visibly uncovered.
    if (consumedReservationIds.has(reservation.reservation_id)) continue
    consumedReservationIds.add(reservation.reservation_id)
    const remaining = remainingByLine.has(reservation.line_id)
      ? Number(remainingByLine.get(reservation.line_id))
      : Number(reservation.line_quantity)
    if (remaining <= 1e-9) continue
    if (!reservation.magasin_id || reservation.emplacement_id === null) {
      throw new HttpError(
        409,
        "RESERVED_STOCK_LOCATION_INVALID",
        "L'emplacement du stock réservé ne peut pas être rattaché au bon de livraison."
      )
    }

    const quantity = Math.min(remaining, Number(reservation.reservation_quantity))
    if (quantity <= 1e-9) continue
    let reservationId = reservation.reservation_id

    if (quantity + 1e-9 < Number(reservation.reservation_quantity)) {
      // Splitting only reassigns an existing ACTIVE commitment; it neither
      // creates nor consumes released quantity. Do not take the Quality lot
      // lock while this function already holds the reservation row lock: the
      // physical shipment rechecks Quality before posting, in the canonical
      // lot -> reservation lock order.
      await db.query(
        `
          UPDATE public.stock_reservations
          SET qty_reserved = qty_reserved - $2,
              row_version = row_version + 1,
              updated_at = now(),
              updated_by = $3
          WHERE id = $1::uuid
            AND status = 'ACTIVE'
        `,
        [reservation.reservation_id, quantity, userId]
      )
      const split = await db.query<{ id: string }>(
        `
          INSERT INTO public.stock_reservations (
            article_id, location_id, qty_reserved, source_type, source_id, status,
            lot_id, stock_batch_id, correlation_id, commande_ligne_id, of_id,
            bon_livraison_ligne_id, affaire_id, reason, created_by, updated_by
          )
          SELECT
            article_id, location_id, $2, 'BON_LIVRAISON_LIGNE', $3::text, 'ACTIVE',
            lot_id, stock_batch_id, correlation_id, commande_ligne_id, of_id,
            $3::uuid, $4::bigint, 'Affectée au bon de livraison ' || $5, $6, $6
          FROM public.stock_reservations
          WHERE id = $1::uuid
          RETURNING id::text AS id
        `,
        [
          reservation.reservation_id,
          quantity,
          reservation.line_id,
          reservation.affaire_id,
          bonLivraisonId,
          userId,
        ]
      )
      reservationId = split.rows[0]?.id ?? ""
      if (!reservationId) throw new Error("Failed to split the order-line stock reservation")
    } else {
      await db.query(
        `
          UPDATE public.stock_reservations
          SET source_type = 'BON_LIVRAISON_LIGNE',
              source_id = $2::text,
              bon_livraison_ligne_id = $2::uuid,
              affaire_id = $3::bigint,
              reason = 'Affectée au bon de livraison ' || $4,
              row_version = row_version + 1,
              updated_at = now(),
              updated_by = $5
          WHERE id = $1::uuid
            AND status = 'ACTIVE'
        `,
        [
          reservation.reservation_id,
          reservation.line_id,
          reservation.affaire_id,
          bonLivraisonId,
          userId,
        ]
      )
    }

    await db.query(
      `
        INSERT INTO public.bon_livraison_ligne_allocations (
          bon_livraison_ligne_id, article_id, lot_id, magasin_id,
          emplacement_id, location_id, stock_level_id, stock_batch_id,
          reservation_id, stock_movement_line_id, quantite, unite,
          created_by, updated_by
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::uuid,$7::uuid,$8::uuid,
          $9::uuid,NULL,$10,$11,$12,$12
        )
      `,
      [
        reservation.line_id,
        reservation.article_id,
        reservation.lot_id,
        reservation.magasin_id,
        reservation.emplacement_id,
        reservation.location_id,
        reservation.stock_level_id,
        reservation.stock_batch_id,
        reservationId,
        quantity,
        reservation.unite,
        userId,
      ]
    )
    remainingByLine.set(reservation.line_id, remaining - quantity)
    attached += 1
  }

  const coverage = await db.query<{ complete: boolean }>(
    `
      SELECT NOT EXISTS(
        SELECT 1
        FROM public.bon_livraison_ligne line
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(allocation.quantite), 0)::numeric AS quantity
          FROM public.bon_livraison_ligne_allocations allocation
          WHERE allocation.bon_livraison_ligne_id = line.id
        ) allocated ON TRUE
        WHERE line.bon_livraison_id = $1::uuid
          AND ABS(line.quantite - COALESCE(allocated.quantity, 0)) > 0.000000001
      ) AS complete
    `,
    [bonLivraisonId]
  )
  return { attached, fullyAllocated: coverage.rows[0]?.complete === true }
}

export async function repoCreateLivraisonFromCommande(
  commandeId: number,
  userId: number,
  transaction?: PoolClient,
  quantitiesByCommandeLine?: ReadonlyMap<number, number>
): Promise<{ id: string }> {
  const work = async (db: PoolClient): Promise<{ id: string }> => {
    const cmdRes = await db.query<{
      id: number
      numero: string
      client_id: string | null
      order_type: string | null
      raw_statut: string | null
      dest_stock_magasin_id: string | null
      dest_stock_emplacement_id: number | null
    }>(
      `
        SELECT
          cc.id,
          cc.numero,
          cc.client_id,
          cc.order_type,
          cc.dest_stock_magasin_id::text AS dest_stock_magasin_id,
          cc.dest_stock_emplacement_id::int AS dest_stock_emplacement_id,
          st.nouveau_statut AS raw_statut
        FROM public.commande_client cc
        LEFT JOIN LATERAL (
          SELECT ch.nouveau_statut
          FROM public.commande_historique ch
          WHERE ch.commande_id = cc.id
          ORDER BY ch.date_action DESC, ch.id DESC
          LIMIT 1
        ) st ON TRUE
        WHERE cc.id = $1
        FOR UPDATE OF cc
      `,
      [commandeId]
    )
    const cmd = cmdRes.rows[0] ?? null
    if (!cmd) throw new HttpError(404, "COMMANDE_NOT_FOUND", "Commande not found")

    const internalOrder = String(cmd.order_type ?? "").toUpperCase() === "INTERNE"
    const currentStatus = cmd.raw_statut === null ? "BROUILLON" : normalizeCommandeWorkflowStatus(cmd.raw_statut)
    if (!currentStatus) {
      throw new HttpError(409, "COMMAND_STATUS_HISTORY_INVALID", "Le dernier statut de la commande est inconnu.")
    }
    if (internalOrder && currentStatus !== "PRET_LIVRAISON") {
      throw new HttpError(
        409,
        "INTERNAL_DELIVERY_QUALITY_RELEASE_REQUIRED",
        "Le BL interne ne peut être créé qu'après fabrication et libération qualité."
      )
    }
    if (internalOrder && (!cmd.dest_stock_magasin_id || cmd.dest_stock_emplacement_id === null)) {
      throw new HttpError(
        409,
        "INTERNAL_STOCK_DESTINATION_REQUIRED",
        "La destination magasin/emplacement de la commande interne est obligatoire pour créer le BL."
      )
    }

    let deliveryClientId = cmd.client_id
    if (internalOrder && !deliveryClientId) {
      const setting = await db.query<{ value_text: string | null }>(
        `SELECT value_text FROM public.erp_settings WHERE key = 'commandes.internal_client_id' LIMIT 1`
      )
      deliveryClientId = setting.rows[0]?.value_text?.trim() || null
    }
    if (!deliveryClientId) {
      throw new HttpError(
        409,
        internalOrder ? "INTERNAL_CLIENT_REQUIRED" : "COMMANDE_CLIENT_REQUIRED",
        "Un client de livraison doit être configuré pour créer le BL."
      )
    }

    let deliveryAddressId: string | null = null
    if (!internalOrder) {
      const clientRes = await db.query<{ delivery_address_id: string | null }>(
        `SELECT delivery_address_id::text AS delivery_address_id FROM clients WHERE client_id = $1`,
        [deliveryClientId]
      )
      deliveryAddressId = clientRes.rows[0]?.delivery_address_id ?? null
    }
    const internalDestination = internalOrder
      ? `Destination stock interne: magasin ${cmd.dest_stock_magasin_id}, emplacement ${cmd.dest_stock_emplacement_id}`
      : null

    const hasRoleColumn = await hasCommandeToAffaireRoleColumn(db)
    const affaireSql = hasRoleColumn
      ? `
        SELECT cta.affaire_id
        FROM commande_to_affaire cta
        WHERE cta.commande_id = $1
          AND (cta.role = 'LIVRAISON' OR cta.role IS NULL)
        ORDER BY (cta.role = 'LIVRAISON') DESC, cta.date_conversion DESC, cta.id DESC
        LIMIT 1
        `
      : `
        SELECT cta.affaire_id
        FROM commande_to_affaire cta
        WHERE cta.commande_id = $1
        ORDER BY cta.date_conversion DESC NULLS LAST, cta.id ASC
        LIMIT 1
        `

    const affaireRes = await db.query<{ affaire_id: number }>(affaireSql, [commandeId])
    const affaireId = affaireRes.rows[0]?.affaire_id ?? null

    const seqRes = await db.query<{ n: string }>(`SELECT nextval('public.bon_livraison_no_seq')::text AS n`)
    const raw = seqRes.rows[0]?.n
    const n = raw ? Number(raw) : NaN
    if (!Number.isFinite(n)) throw new Error("Failed to reserve bon_livraison number")
    const numero = String(`BL-${String(n).padStart(8, "0")}`).slice(0, 30)

    let id: string

    try {
      const ins = await db.query<{ id: string }>(
        `
        INSERT INTO bon_livraison (
          numero,
          client_id,
          commande_id,
          affaire_id,
          adresse_livraison_id,
          commentaire_interne,
          statut,
          date_creation,
          created_by,
          updated_by
        ) VALUES ($1,$2,$3,$4,$5::uuid,$6,'DRAFT',CURRENT_DATE,$7,$7)
        RETURNING id::text AS id
        `,
        [numero, deliveryClientId, cmd.id, affaireId, deliveryAddressId, internalDestination, userId]
      )

      id = ins.rows[0]?.id ?? ""
      if (!id) throw new Error("Failed to create bon_livraison")
    } catch (err) {
      const { code, constraint } = getPgErrorInfo(err)
      if (code === "23505" && constraint === "bon_livraison_numero_key") {
        throw new HttpError(409, "BON_LIVRAISON_NUMERO_EXISTS", "Bon de livraison numero already exists")
      }
      throw err
    }

    const lignesRes = await db.query<{
      id: string
      designation: string
      code_piece: string | null
      quantite: number
      unite: string | null
      delai_client: string | null
    }>(
      `
      SELECT
        line.id::text AS id,
        line.designation,
        line.code_piece,
        remainder.quantite_restante::float8 AS quantite,
        line.unite,
        line.delai_client
      FROM public.commande_ligne line
      JOIN public.v_bon_livraison_reliquats_226 remainder
        ON remainder.commande_ligne_id = line.id
      WHERE line.commande_id = $1
        AND remainder.quantite_restante > 0
      ORDER BY line.id ASC
      `,
      [commandeId]
    )
    const lignes = lignesRes.rows.flatMap((line) => {
      // PostgreSQL BIGINT values are returned as strings by node-postgres. Normalize the
      // identifier before consulting the numeric map produced by the stock analysis.
      const commandeLineId = Number(line.id)
      if (!Number.isSafeInteger(commandeLineId) || commandeLineId <= 0) {
        throw new Error(`Invalid commande line identifier: ${line.id}`)
      }
      const requestedQuantity = quantitiesByCommandeLine
        ? Number(quantitiesByCommandeLine.get(commandeLineId) ?? 0)
        : Number(line.quantite)
      if (!Number.isFinite(requestedQuantity) || requestedQuantity < 0) {
        throw new HttpError(400, "INVALID_DELIVERY_QUANTITY", `Quantité de BL invalide pour la ligne ${commandeLineId}.`)
      }
      if (requestedQuantity <= 1e-9) return []
      if (requestedQuantity > Number(line.quantite) + 1e-9) {
        throw new HttpError(
          409,
          "DELIVERY_QUANTITY_EXCEEDS_REMAINDER",
          `La quantité de BL dépasse le reliquat de la ligne ${commandeLineId}.`
        )
      }
      return [{ ...line, id: commandeLineId, quantite: requestedQuantity }]
    })
    if (!lignes.length) {
      throw new HttpError(
        409,
        "NO_DELIVERABLE_REMAINDER",
        "Cette commande ne possède plus de reliquat livrable."
      )
    }
    const outLines: InsertLineInput[] = lignes.map((l, idx) => ({
      ordre: idx + 1,
      designation: l.designation,
      code_piece: l.code_piece,
      quantite: l.quantite,
      unite: l.unite,
      commande_ligne_id: l.id,
      delai_client: l.delai_client,
    }))

    await insertLines(db, id, outLines, userId)

    const transferredReservations = await attachActiveCommandeReservationsToLivraison(
      db,
      id,
      userId
    )
    if (transferredReservations.fullyAllocated) {
      await prepareLivraisonInTransaction(db, id, userId)
    }

    await insertEvent(db, {
      bon_livraison_id: id,
      event_type: "CREATED_FROM_COMMANDE",
      user_id: userId,
      new_values: {
        id,
        numero,
        commande_id: cmd.id,
        commande_numero: cmd.numero,
        internal_stock_destination: internalOrder
          ? {
              magasin_id: cmd.dest_stock_magasin_id,
              emplacement_id: cmd.dest_stock_emplacement_id,
            }
          : null,
        reservations_transferred: transferredReservations.attached,
        prepared: transferredReservations.fullyAllocated,
      },
    })

    return { id }
  }

  if (transaction) return work(transaction)
  const db = await pool.connect()
  return withRealtimeOutboxTransaction(db, work)
}

async function ensureDocsDir(): Promise<string> {
  const baseDir = ensureDocumentStoragePath("livraisons")
  await fs.mkdir(baseDir, { recursive: true })
  return baseDir
}

export async function repoAttachLivraisonDocuments(params: {
  bonLivraisonId: string
  documents: UploadedDocument[]
  type?: string | null
  userId: number
}): Promise<BonLivraisonDocument[]> {
  const docsDir = await ensureDocsDir()
  const db = await pool.connect()
  const expected = new Map<string, { key: string; absolutePath: string }>()
  return withUploadTransaction({
    client: db,
    files: params.documents,
    context: "livraisons.documents.attach",
    work: async () => {
    const header = await getHeader(db, params.bonLivraisonId, { forUpdate: true })
    if (!header) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
    if (header.statut === "DELIVERED" || header.statut === "CANCELLED") {
      throw new HttpError(
        409,
        "LOCKED",
        `Document upload is not allowed when statut=${header.statut}`
      )
    }

    const insertedDocIds: string[] = []

    for (const doc of params.documents) {
      const documentId = crypto.randomUUID()
      const isPdf = doc.originalname.toLowerCase().endsWith(".pdf")
      const docType = isPdf ? "PDF" : doc.mimetype
      const checksumSha256 = crypto
        .createHash("sha256")
        .update(await fs.readFile(doc.path))
        .digest("hex")

      const extCandidate = path.extname(doc.originalname).toLowerCase()
      const safeExt = /^\.[a-z0-9]+$/.test(extCandidate) && extCandidate.length <= 10 ? extCandidate : ""
      const finalPath = path.join(docsDir, `${documentId}${safeExt}`)

      await transferSecureUploadToDestination(doc, finalPath)

      await db.query(`INSERT INTO documents_clients (id, document_name, type) VALUES ($1, $2, $3)`, [
        documentId,
        doc.originalname,
        docType,
      ])
      await db.query(
        `
        INSERT INTO bon_livraison_documents (
          bon_livraison_id,
          document_id,
          type,
          version,
          uploaded_by,
          checksum_sha256,
          file_size_bytes,
          mime_type
        )
        VALUES ($1, $2, $3, 1, $4, $5, $6, $7)
        `,
        [
          params.bonLivraisonId,
          documentId,
          params.type ?? (isPdf ? "PDF" : null),
          params.userId,
          checksumSha256,
          doc.size,
          doc.mimetype,
        ]
      )

      insertedDocIds.push(documentId)
      expected.set(documentId, {
        key: `${params.bonLivraisonId}|${documentId}|${checksumSha256}|${doc.originalname}|${docType}`,
        absolutePath: finalPath,
      })
    }

    await db.query(`UPDATE bon_livraison SET updated_at = now(), updated_by = $2 WHERE id = $1::uuid`, [params.bonLivraisonId, params.userId])
    await insertEvent(db, {
      bon_livraison_id: params.bonLivraisonId,
      event_type: "DOC_ADDED",
      user_id: params.userId,
      new_values: { count: params.documents.length, type: params.type ?? null },
    })

    let docsOut: BonLivraisonDocument[] = []
    if (insertedDocIds.length) {
      const rows = await db.query<{
        id: string
        bon_livraison_id: string
        document_id: string
        type: string | null
        version: number
        created_at: string
        document_name: string | null
        document_type: string | null
        checksum_sha256: string | null
        file_size_bytes: number | null
        mime_type: string | null
      }>(
        `
        SELECT
          d.id::text AS id,
          d.bon_livraison_id::text AS bon_livraison_id,
          d.document_id::text AS document_id,
          d.type,
          d.version,
          d.created_at::text AS created_at,
          dc.document_name,
          dc.type AS document_type,
          d.checksum_sha256,
          d.file_size_bytes::float8 AS file_size_bytes,
          d.mime_type
        FROM bon_livraison_documents d
        LEFT JOIN documents_clients dc ON dc.id = d.document_id
        WHERE d.bon_livraison_id = $1::uuid
          AND d.document_id = ANY($2::uuid[])
        ORDER BY d.id DESC
        `,
        [params.bonLivraisonId, insertedDocIds]
      )
      docsOut = rows.rows.map((r) => ({
        id: r.id,
        bon_livraison_id: r.bon_livraison_id,
        document_id: r.document_id,
        type: r.type,
        version: r.version,
        created_at: r.created_at,
        uploaded_by: null,
        document_name: r.document_name,
        document_type: r.document_type,
        checksum_sha256: r.checksum_sha256,
        file_size_bytes: r.file_size_bytes,
        mime_type: r.mime_type,
      }))
    }

    return docsOut
    },
    reconcile: async () => {
      const ids = [...expected.keys()]
      if (!ids.length) return "committed"
      const { rows } = await pool.query<{
        bon_livraison_id: string | null
        document_id: string
        checksum_sha256: string | null
        document_name: string | null
        document_type: string | null
      }>(
        `SELECT bld.bon_livraison_id::text AS bon_livraison_id,
                dc.id::text AS document_id,
                bld.checksum_sha256,
                dc.document_name,
                dc.type AS document_type
           FROM public.documents_clients dc
           LEFT JOIN public.bon_livraison_documents bld
             ON bld.document_id = dc.id AND bld.bon_livraison_id = $1::uuid
          WHERE dc.id = ANY($2::uuid[])`,
        [params.bonLivraisonId, ids]
      )
      const status = classifyUploadReconciliation(
        [...expected.values()].map((entry) => entry.key),
        rows.map((row) => `${row.bon_livraison_id ?? ""}|${row.document_id}|${row.checksum_sha256 ?? ""}|${row.document_name ?? ""}|${row.document_type ?? ""}`)
      )
      if (status !== "committed") return status
      const present = await Promise.all([...expected.values()].map((entry) => fs.stat(entry.absolutePath).then((stat) => stat.isFile()).catch(() => false)))
      return present.every(Boolean) ? "committed" : "uncertain"
    },
  })
}

export async function repoRemoveLivraisonDocument(params: {
  bonLivraisonId: string
  documentId: string
  userId: number
}): Promise<boolean> {
  const db = await pool.connect()
  return withRealtimeOutboxTransaction(db, async (db) => {
    const header = await getHeader(db, params.bonLivraisonId, { forUpdate: true })
    if (!header) {
      return false
    }
    if (header.statut !== "DRAFT") {
      throw new HttpError(
        409,
        "DOCUMENT_IMMUTABLE",
        "Un document ne peut être retiré qu’au statut DRAFT."
      )
    }

    const delRes = await db.query(
      `DELETE FROM bon_livraison_documents WHERE bon_livraison_id = $1::uuid AND document_id = $2::uuid`,
      [params.bonLivraisonId, params.documentId]
    )
    const ok = (delRes.rowCount ?? 0) > 0

    if (ok) {
      await db.query(`UPDATE bon_livraison SET updated_at = now(), updated_by = $2 WHERE id = $1::uuid`, [params.bonLivraisonId, params.userId])
      await insertEvent(db, {
        bon_livraison_id: params.bonLivraisonId,
        event_type: "DOC_REMOVED",
        user_id: params.userId,
        old_values: { document_id: params.documentId },
      })
    }

    return ok
  })
}

export async function repoGetDocumentName(documentId: string): Promise<string | null> {
  const res = await pool.query<{ document_name: string }>(`SELECT document_name FROM documents_clients WHERE id = $1`, [documentId])
  const name = res.rows[0]?.document_name
  return typeof name === "string" && name.trim() ? name.trim() : null
}

export async function repoFindDocumentFilePath(documentId: string): Promise<string | null> {
  const baseDir = await ensureDocsDir()
  const pdfCandidate = path.join(baseDir, `${documentId}.pdf`)
  try {
    await fs.stat(pdfCandidate)
    return pdfCandidate
  } catch {
    // continue
  }

  const entries = await fs.readdir(baseDir).catch(() => [])
  const match = entries.find((e) => e.startsWith(documentId))
  if (!match) return null
  const candidate = path.join(baseDir, match)
  try {
    await fs.stat(candidate)
    return candidate
  } catch {
    return null
  }
}

export async function repoIsLivraisonDocumentLinked(bonLivraisonId: string, documentId: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM bon_livraison_documents WHERE bon_livraison_id = $1::uuid AND document_id = $2::uuid LIMIT 1`,
    [bonLivraisonId, documentId]
  )
  return (res.rowCount ?? 0) > 0
}
