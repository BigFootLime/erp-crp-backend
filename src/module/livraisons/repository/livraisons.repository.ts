import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import type { PoolClient } from "pg"

import pool from "../../../config/database"
import { HttpError } from "../../../utils/httpError"

import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"

import type {
  AdresseLivraisonLite,
  BonLivraisonDetail,
  BonLivraisonDocument,
  BonLivraisonEventLog,
  BonLivraisonHeader,
  BonLivraisonLigne,
  BonLivraisonLigneAllocation,
  BonLivraisonListItem,
  BonLivraisonStatut,
  Paginated,
  UploadedDocument,
  UserLite,
} from "../types/livraisons.types"
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

async function resolveUnitIdForArticle(
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
  if (!code) code = "u"

  const u = await db.query<{ id: string }>(`SELECT id::text AS id FROM public.units WHERE code = $1`, [code])
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

export async function repoListLivraisons(filters: ListLivraisonsQueryDTO): Promise<Paginated<BonLivraisonListItem>> {
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

  return { items, total }
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
        dc.type AS document_type
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

    return { bon_livraison, lignes, documents, events }
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
  await client.query(
    `
    INSERT INTO bon_livraison_event_log (bon_livraison_id, event_type, old_values, new_values, user_id)
    VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5)
    `,
    [
      params.bon_livraison_id,
      params.event_type,
      params.old_values === undefined ? null : JSON.stringify(params.old_values),
      params.new_values === undefined ? null : JSON.stringify(params.new_values),
      params.user_id,
    ]
  )
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
  try {
    await db.query("BEGIN")

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

    await db.query("COMMIT")
    return { id }
  } catch (err) {
    await db.query("ROLLBACK")
    throw err
  } finally {
    db.release()
  }
}

export async function repoUpdateLivraisonHeader(id: string, patch: UpdateLivraisonBodyDTO, userId: number): Promise<{ id: string } | null> {
  const db = await pool.connect()
  try {
    await db.query("BEGIN")
    const current = await getHeader(db, id, { forUpdate: true })
    if (!current) {
      await db.query("ROLLBACK")
      return null
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
      await db.query("ROLLBACK")
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

    await db.query("COMMIT")
    return { id }
  } catch (err) {
    await db.query("ROLLBACK")
    throw err
  } finally {
    db.release()
  }
}

export async function repoAddLivraisonLine(
  bonLivraisonId: string,
  input: CreateLivraisonLineBodyDTO,
  userId: number
): Promise<{ lineId: string }> {
  const db = await pool.connect()
  try {
    await db.query("BEGIN")
    const current = await getHeader(db, bonLivraisonId, { forUpdate: true })
    if (!current) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")

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

    await db.query("COMMIT")
    return { lineId }
  } catch (err) {
    await db.query("ROLLBACK")
    throw err
  } finally {
    db.release()
  }
}

export async function repoUpdateLivraisonLine(
  bonLivraisonId: string,
  lineId: string,
  patch: UpdateLivraisonLineBodyDTO,
  userId: number
): Promise<{ lineId: string } | null> {
  const db = await pool.connect()
  try {
    await db.query("BEGIN")
    const header = await getHeader(db, bonLivraisonId, { forUpdate: true })
    if (!header) {
      await db.query("ROLLBACK")
      return null
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
      await db.query("ROLLBACK")
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
      await db.query("ROLLBACK")
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

    await db.query("COMMIT")
    return { lineId }
  } catch (err) {
    await db.query("ROLLBACK")
    throw err
  } finally {
    db.release()
  }
}

export async function repoDeleteLivraisonLine(bonLivraisonId: string, lineId: string, userId: number): Promise<boolean> {
  const db = await pool.connect()
  try {
    await db.query("BEGIN")
    const header = await getHeader(db, bonLivraisonId, { forUpdate: true })
    if (!header) {
      await db.query("ROLLBACK")
      return false
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

    await db.query("COMMIT")
    return ok
  } catch (err) {
    await db.query("ROLLBACK")
    throw err
  } finally {
    db.release()
  }
}

export async function repoCreateLivraisonLineAllocation(
  bonLivraisonId: string,
  lineId: string,
  input: CreateLivraisonAllocationBodyDTO,
  userId: number
): Promise<{ allocationId: string }> {
  const db = await pool.connect()
  try {
    await db.query("BEGIN")
    const header = await getHeader(db, bonLivraisonId, { forUpdate: true })
    if (!header) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")

    const lineRes = await db.query<{ id: string }>(
      `SELECT id::text AS id FROM bon_livraison_ligne WHERE bon_livraison_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
      [bonLivraisonId, lineId]
    )
    const line = lineRes.rows[0] ?? null
    if (!line) throw new HttpError(404, "LINE_NOT_FOUND", "Bon de livraison line not found")

    const articleOk = await db.query<{ ok: number }>(`SELECT 1::int AS ok FROM public.articles WHERE id = $1::uuid LIMIT 1`, [input.article_id])
    if (!articleOk.rows[0]?.ok) {
      throw new HttpError(400, "INVALID_ARTICLE", "Unknown article_id")
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
      if (lotStatus === "BLOQUE") {
        throw new HttpError(409, "LOT_BLOCKED", "Ce lot est bloque et ne peut pas etre consomme")
      }
    }

    const ins = await db.query<{ id: string }>(
      `
        INSERT INTO public.bon_livraison_ligne_allocations (
          bon_livraison_ligne_id,
          article_id,
          lot_id,
          stock_movement_line_id,
          quantite,
          unite,
          created_by,
          updated_by
        ) VALUES ($1::uuid,$2::uuid,$3::uuid,NULL,$4,$5,$6,$6)
        RETURNING id::text AS id
      `,
      [lineId, input.article_id, input.lot_id ?? null, input.quantite, input.unite ?? null, userId]
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
        quantite: input.quantite,
        unite: input.unite ?? null,
      },
    })

    await db.query("COMMIT")
    return { allocationId }
  } catch (err) {
    await db.query("ROLLBACK")
    throw err
  } finally {
    db.release()
  }
}

export async function repoDeleteLivraisonLineAllocation(
  bonLivraisonId: string,
  lineId: string,
  allocationId: string,
  userId: number
): Promise<boolean> {
  const db = await pool.connect()
  try {
    await db.query("BEGIN")
    const header = await getHeader(db, bonLivraisonId, { forUpdate: true })
    if (!header) {
      await db.query("ROLLBACK")
      return false
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
      await db.query("ROLLBACK")
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

    await db.query("COMMIT")
    return ok
  } catch (err) {
    await db.query("ROLLBACK")
    throw err
  } finally {
    db.release()
  }
}

export async function repoUpdateLivraisonStatus(
  bonLivraisonId: string,
  statut: BonLivraisonStatut,
  userId: number,
  meta?: { commentaire?: string | null }
): Promise<{ id: string; statut: BonLivraisonStatut }> {
  const db = await pool.connect()
  try {
    await db.query("BEGIN")
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
             a.quantite,
             a.unite
           FROM public.bon_livraison_ligne_allocations a
           JOIN public.bon_livraison_ligne l ON l.id = a.bon_livraison_ligne_id
           LEFT JOIN public.lots lt ON lt.id = a.lot_id
           WHERE l.bon_livraison_id = $1::uuid
           ORDER BY a.created_at ASC, a.id ASC
         `,
         [bonLivraisonId]
       )
       const allocRows = allocRes.rows

       const blocked = allocRows.find((a) => Boolean(a.lot_id) && a.lot_status === "BLOQUE")
       if (blocked?.lot_id) {
         throw new HttpError(409, "LOT_BLOCKED", "Expedition impossible: un lot alloue est bloque")
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
         })
         groups.set(key, g)
       }

       for (const g of groups.values()) {
         const totalQty = g.items.reduce((acc, it) => acc + it.quantite, 0)
         if (!Number.isFinite(totalQty) || totalQty <= 0) {
           throw new HttpError(400, "INVALID_QTY", "Invalid allocated qty")
         }

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

    await db.query("COMMIT")
    return { id: bonLivraisonId, statut }
  } catch (err) {
    await db.query("ROLLBACK")
    throw err
  } finally {
    db.release()
  }
}

export async function repoCreateLivraisonFromCommande(commandeId: number, userId: number): Promise<{ id: string }> {
  const db = await pool.connect()
  try {
    await db.query("BEGIN")

    const cmdRes = await db.query<{ id: number; numero: string; client_id: string }>(
      `SELECT id, numero, client_id FROM commande_client WHERE id = $1`,
      [commandeId]
    )
    const cmd = cmdRes.rows[0] ?? null
    if (!cmd) throw new HttpError(404, "COMMANDE_NOT_FOUND", "Commande not found")

    const clientRes = await db.query<{ delivery_address_id: string | null }>(
      `SELECT delivery_address_id::text AS delivery_address_id FROM clients WHERE client_id = $1`,
      [cmd.client_id]
    )
    const deliveryAddressId = clientRes.rows[0]?.delivery_address_id ?? null

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
          statut,
          date_creation,
          created_by,
          updated_by
        ) VALUES ($1,$2,$3,$4,$5::uuid,'DRAFT',CURRENT_DATE,$6,$6)
        RETURNING id::text AS id
        `,
        [numero, cmd.client_id, cmd.id, affaireId, deliveryAddressId, userId]
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
      id: number
      designation: string
      code_piece: string | null
      quantite: number
      unite: string | null
      delai_client: string | null
    }>(
      `
      SELECT id, designation, code_piece, quantite::float8 AS quantite, unite, delai_client
      FROM commande_ligne
      WHERE commande_id = $1
      ORDER BY id ASC
      `,
      [commandeId]
    )
    const lignes = lignesRes.rows
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

    await insertEvent(db, {
      bon_livraison_id: id,
      event_type: "CREATED_FROM_COMMANDE",
      user_id: userId,
      new_values: { id, numero, commande_id: cmd.id, commande_numero: cmd.numero },
    })

    await db.query("COMMIT")
    return { id }
  } catch (err) {
    await db.query("ROLLBACK")
    throw err
  } finally {
    db.release()
  }
}

async function ensureDocsDir(): Promise<string> {
  const baseDir = path.resolve("uploads/docs/livraisons")
  await fs.mkdir(baseDir, { recursive: true })
  return baseDir
}

export async function repoAttachLivraisonDocuments(params: {
  bonLivraisonId: string
  documents: UploadedDocument[]
  type?: string | null
  userId: number
}): Promise<BonLivraisonDocument[]> {
  const db = await pool.connect()
  const docsDir = await ensureDocsDir()
  try {
    await db.query("BEGIN")
    const header = await getHeader(db, params.bonLivraisonId, { forUpdate: true })
    if (!header) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")

    const insertedDocIds: string[] = []

    for (const doc of params.documents) {
      const documentId = crypto.randomUUID()
      const isPdf = doc.originalname.toLowerCase().endsWith(".pdf")
      const docType = isPdf ? "PDF" : doc.mimetype

      const extCandidate = path.extname(doc.originalname).toLowerCase()
      const safeExt = /^\.[a-z0-9]+$/.test(extCandidate) && extCandidate.length <= 10 ? extCandidate : ""
      const finalPath = path.join(docsDir, `${documentId}${safeExt}`)

      try {
        await fs.rename(doc.path, finalPath)
      } catch {
        await fs.copyFile(doc.path, finalPath)
        await fs.unlink(doc.path)
      }

      await db.query(`INSERT INTO documents_clients (id, document_name, type) VALUES ($1, $2, $3)`, [
        documentId,
        doc.originalname,
        docType,
      ])
      await db.query(
        `
        INSERT INTO bon_livraison_documents (bon_livraison_id, document_id, type, version, uploaded_by)
        VALUES ($1, $2, $3, 1, $4)
        `,
        [params.bonLivraisonId, documentId, params.type ?? (isPdf ? "PDF" : null), params.userId]
      )

      insertedDocIds.push(documentId)
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
          dc.type AS document_type
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
      }))
    }

    await db.query("COMMIT")
    return docsOut
  } catch (err) {
    await db.query("ROLLBACK")
    throw err
  } finally {
    db.release()
  }
}

export async function repoRemoveLivraisonDocument(params: {
  bonLivraisonId: string
  documentId: string
  userId: number
}): Promise<boolean> {
  const db = await pool.connect()
  try {
    await db.query("BEGIN")
    const header = await getHeader(db, params.bonLivraisonId, { forUpdate: true })
    if (!header) {
      await db.query("ROLLBACK")
      return false
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

    await db.query("COMMIT")
    return ok
  } catch (err) {
    await db.query("ROLLBACK")
    throw err
  } finally {
    db.release()
  }
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
