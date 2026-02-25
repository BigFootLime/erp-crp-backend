import type { PoolClient } from "pg"
import crypto from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import db from "../../../config/database"
import { HttpError } from "../../../utils/httpError"
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators"
import { repoCreateMovement, repoPostMovement } from "../../stock/repository/stock.repository"
import type { StockMovementDetail } from "../../stock/types/stock.types"
import type {
  AddMeasurementBodyDTO,
  AttachDocumentsBodyDTO,
  CreateLineBodyDTO,
  CreateLotForLineBodyDTO,
  CreateReceptionBodyDTO,
  DecideInspectionBodyDTO,
  ListReceptionsQueryDTO,
  PatchReceptionBodyDTO,
  StockReceiptBodyDTO,
} from "../validators/receptions.validators"
import type {
  Paginated,
  ReceptionFournisseur,
  ReceptionFournisseurDetail,
  ReceptionFournisseurDocument,
  ReceptionFournisseurLine,
  ReceptionFournisseurListItem,
  ReceptionIncomingInspection,
  ReceptionIncomingMeasurement,
  ReceptionKpis,
  ReceptionStockReceipt,
} from "../types/receptions.types"

export type AuditContext = {
  user_id: number
  ip: string | null
  user_agent: string | null
  device_type: string | null
  os: string | null
  browser: string | null
  path: string | null
  page_key: string | null
  client_session_id: string | null
}

type DbQueryer = Pick<PoolClient, "query">
type UploadedDocument = Express.Multer.File

function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505"
}

function sortDirection(dir: "asc" | "desc" | undefined): "ASC" | "DESC" {
  return dir === "asc" ? "ASC" : "DESC"
}

function receptionSortColumn(sortBy: ListReceptionsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "updated_at":
      return "r.updated_at"
    case "reception_no":
      return "r.reception_no"
    case "status":
      return "r.status"
    case "reception_date":
    default:
      return "r.reception_date"
  }
}

function normalizeLikeQuery(raw: string): string {
  return `%${raw.trim()}%`
}

function safeDocExtension(originalName: string): string {
  const extCandidate = path.extname(originalName).toLowerCase()
  return /^\.[a-z0-9]+$/.test(extCandidate) && extCandidate.length <= 10 ? extCandidate : ""
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join(path.posix.sep)
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256")
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest("hex")
}

async function insertAuditLog(tx: DbQueryer, audit: AuditContext, entry: {
  action: string
  entity_type: string | null
  entity_id: string | null
  details?: Record<string, unknown> | null
}) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: entry.details ?? null,
  }

  await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  })
}

async function ensureReceptionExists(tx: DbQueryer, id: string): Promise<boolean> {
  const res = await tx.query<{ ok: number }>(
    `SELECT 1::int AS ok FROM public.receptions_fournisseurs WHERE id = $1::uuid LIMIT 1`,
    [id]
  )
  return Boolean(res.rows[0]?.ok)
}

function receptionNoFromSeq(n: number): string {
  const padded = String(n).padStart(8, "0")
  return `RF-${padded}`
}

async function reserveReceptionNo(client: Pick<PoolClient, "query">): Promise<string> {
  const res = await client.query<{ n: string }>(`SELECT nextval('public.reception_fournisseur_no_seq')::text AS n`)
  const raw = res.rows[0]?.n
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n)) throw new Error("Failed to reserve reception number")
  return receptionNoFromSeq(n)
}

type ReceptionRow = {
  id: string
  reception_no: string
  fournisseur_id: string
  status: string
  reception_date: string
  supplier_reference: string | null
  commentaire: string | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

function mapReceptionRow(r: ReceptionRow): ReceptionFournisseur {
  return {
    id: r.id,
    reception_no: r.reception_no,
    fournisseur_id: r.fournisseur_id,
    status: r.status,
    reception_date: r.reception_date,
    supplier_reference: r.supplier_reference,
    commentaire: r.commentaire,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
    updated_by: r.updated_by,
  }
}

type ReceptionListRow = {
  id: string
  reception_no: string
  fournisseur_id: string
  fournisseur_code: string
  fournisseur_nom: string
  status: string
  reception_date: string
  supplier_reference: string | null
  lines_count: number
  pending_lines_count: number
  blocked_lines_count: number
  updated_at: string
}

type LineRow = {
  id: string
  reception_id: string
  line_no: number
  article_id: string
  article_code: string | null
  article_designation: string | null
  designation: string | null
  qty_received: number
  unite: string | null
  supplier_lot_code: string | null
  lot_id: string | null
  lot_code: string | null
  lot_status: string | null
  inspection_status: string | null
  inspection_decision: string | null
  notes: string | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

type DocumentRow = {
  id: string
  reception_id: string
  reception_line_id: string | null
  document_type: string
  commentaire: string | null
  original_name: string
  stored_name: string
  storage_path: string
  mime_type: string
  size_bytes: string
  sha256: string | null
  label: string | null
  uploaded_by: number | null
  removed_at: string | null
  removed_by: number | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

type InspectionRow = {
  id: string
  reception_id: string
  reception_line_id: string
  lot_id: string
  status: string
  decision: string | null
  decision_note: string | null
  started_at: string
  decided_at: string | null
  decided_by: number | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

type MeasurementRow = {
  id: string
  inspection_id: string
  characteristic: string
  nominal_value: number | null
  tolerance_min: number | null
  tolerance_max: number | null
  measured_value: number | null
  unit: string | null
  result: string | null
  comment: string | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

type ReceiptRow = {
  id: string
  reception_id: string
  reception_line_id: string
  stock_movement_id: string
  qty: number
  created_at: string
  created_by: number | null
}

function mapLineRow(r: LineRow): ReceptionFournisseurLine {
  return { ...r }
}

function mapReceptionListRow(r: ReceptionListRow): ReceptionFournisseurListItem {
  return { ...r }
}

function mapDocumentRow(r: DocumentRow): ReceptionFournisseurDocument {
  return {
    id: r.id,
    reception_id: r.reception_id,
    reception_line_id: r.reception_line_id,
    document_type: r.document_type,
    commentaire: r.commentaire,
    original_name: r.original_name,
    stored_name: r.stored_name,
    storage_path: r.storage_path,
    mime_type: r.mime_type,
    size_bytes: Number(r.size_bytes),
    sha256: r.sha256,
    label: r.label,
    uploaded_by: r.uploaded_by,
    removed_at: r.removed_at,
    removed_by: r.removed_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
    updated_by: r.updated_by,
  }
}

function mapMeasurementRow(r: MeasurementRow): ReceptionIncomingMeasurement {
  return { ...r }
}

function mapInspectionRow(r: InspectionRow, measurements: ReceptionIncomingMeasurement[]): ReceptionIncomingInspection {
  return { ...r, measurements }
}

function mapReceiptRow(r: ReceiptRow): ReceptionStockReceipt {
  return { ...r }
}

async function selectLineDetail(tx: DbQueryer, lineId: string): Promise<ReceptionFournisseurLine | null> {
  const res = await tx.query<LineRow>(
    `
      SELECT
        l.id::text AS id,
        l.reception_id::text AS reception_id,
        l.line_no,
        l.article_id::text AS article_id,
        a.code AS article_code,
        a.designation AS article_designation,
        l.designation,
        l.qty_received::float8 AS qty_received,
        l.unite,
        l.supplier_lot_code,
        l.lot_id::text AS lot_id,
        lot.lot_code,
        lot.lot_status,
        i.status AS inspection_status,
        i.decision AS inspection_decision,
        l.notes,
        l.created_at::text AS created_at,
        l.updated_at::text AS updated_at,
        l.created_by,
        l.updated_by
      FROM public.reception_fournisseur_lignes l
      LEFT JOIN public.articles a ON a.id = l.article_id
      LEFT JOIN public.lots lot ON lot.id = l.lot_id
      LEFT JOIN public.reception_incoming_inspections i ON i.reception_line_id = l.id
      WHERE l.id = $1::uuid
      LIMIT 1
    `,
    [lineId]
  )
  const row = res.rows[0] ?? null
  return row ? mapLineRow(row) : null
}

export async function repoListReceptions(filters: ListReceptionsQueryDTO): Promise<Paginated<ReceptionFournisseurListItem>> {
  const where: string[] = []
  const values: unknown[] = []
  const push = (v: unknown) => {
    values.push(v)
    return `$${values.length}`
  }

  if (filters.q && filters.q.trim()) {
    const q = normalizeLikeQuery(filters.q)
    const p = push(q)
    where.push(`(
      r.reception_no ILIKE ${p}
      OR COALESCE(r.supplier_reference,'') ILIKE ${p}
      OR f.code ILIKE ${p}
      OR f.nom ILIKE ${p}
    )`)
  }
  if (filters.fournisseur_id) where.push(`r.fournisseur_id = ${push(filters.fournisseur_id)}::uuid`)
  if (filters.status) where.push(`r.status = ${push(filters.status)}`)
  if (filters.date_from) where.push(`r.reception_date >= ${push(filters.date_from)}::date`)
  if (filters.date_to) where.push(`r.reception_date <= ${push(filters.date_to)}::date`)

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const page = filters.page ?? 1
  const pageSize = filters.pageSize ?? 20
  const offset = (page - 1) * pageSize
  const orderBy = receptionSortColumn(filters.sortBy)
  const orderDir = sortDirection(filters.sortDir)

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.receptions_fournisseurs r JOIN public.fournisseurs f ON f.id = r.fournisseur_id ${whereSql}`,
    values
  )
  const total = countRes.rows[0]?.total ?? 0

  const dataSql = `
    SELECT
      r.id::text AS id,
      r.reception_no,
      r.fournisseur_id::text AS fournisseur_id,
      f.code AS fournisseur_code,
      f.nom AS fournisseur_nom,
      r.status,
      r.reception_date::text AS reception_date,
      r.supplier_reference,
      COALESCE(agg.lines_count, 0)::int AS lines_count,
      COALESCE(agg.pending_lines_count, 0)::int AS pending_lines_count,
      COALESCE(agg.blocked_lines_count, 0)::int AS blocked_lines_count,
      r.updated_at::text AS updated_at
    FROM public.receptions_fournisseurs r
    JOIN public.fournisseurs f ON f.id = r.fournisseur_id
    LEFT JOIN (
      SELECT
        l.reception_id,
        COUNT(*)::int AS lines_count,
        SUM(CASE WHEN COALESCE(lot.lot_status, 'LIBERE') = 'EN_ATTENTE' THEN 1 ELSE 0 END)::int AS pending_lines_count,
        SUM(CASE WHEN COALESCE(lot.lot_status, 'LIBERE') = 'BLOQUE' THEN 1 ELSE 0 END)::int AS blocked_lines_count
      FROM public.reception_fournisseur_lignes l
      LEFT JOIN public.lots lot ON lot.id = l.lot_id
      GROUP BY l.reception_id
    ) agg ON agg.reception_id = r.id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}, r.id ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `

  const rows = await db.query<ReceptionListRow>(dataSql, [...values, pageSize, offset])
  return { items: rows.rows.map(mapReceptionListRow), total }
}

export async function repoGetReceptionsKpis(): Promise<{ kpis: ReceptionKpis }> {
  const res = await db.query<{
    total: number
    open: number
    pending_inspection: number
    blocked_lots: number
  }>(
    `
      SELECT
        (SELECT COUNT(*)::int FROM public.receptions_fournisseurs) AS total,
        (SELECT COUNT(*)::int FROM public.receptions_fournisseurs WHERE status = 'OPEN') AS open,
        (
          SELECT COUNT(*)::int
          FROM public.reception_fournisseur_lignes l
          LEFT JOIN public.lots lot ON lot.id = l.lot_id
          WHERE COALESCE(lot.lot_status, 'LIBERE') = 'EN_ATTENTE'
        ) AS pending_inspection,
        (
          SELECT COUNT(*)::int
          FROM public.reception_fournisseur_lignes l
          LEFT JOIN public.lots lot ON lot.id = l.lot_id
          WHERE COALESCE(lot.lot_status, 'LIBERE') = 'BLOQUE'
        ) AS blocked_lots
    `
  )

  const row = res.rows[0]
  return {
    kpis: {
      total: row?.total ?? 0,
      open: row?.open ?? 0,
      pending_inspection: row?.pending_inspection ?? 0,
      blocked_lots: row?.blocked_lots ?? 0,
    },
  }
}

export async function repoGetReception(id: string): Promise<ReceptionFournisseurDetail | null> {
  const receptionRes = await db.query<ReceptionRow>(
    `
      SELECT
        id::text AS id,
        reception_no,
        fournisseur_id::text AS fournisseur_id,
        status,
        reception_date::text AS reception_date,
        supplier_reference,
        commentaire,
        created_at::text AS created_at,
        updated_at::text AS updated_at,
        created_by,
        updated_by
      FROM public.receptions_fournisseurs
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [id]
  )
  const r = receptionRes.rows[0] ?? null
  if (!r) return null

  const lines = await db.query<LineRow>(
    `
      SELECT
        l.id::text AS id,
        l.reception_id::text AS reception_id,
        l.line_no,
        l.article_id::text AS article_id,
        a.code AS article_code,
        a.designation AS article_designation,
        l.designation,
        l.qty_received::float8 AS qty_received,
        l.unite,
        l.supplier_lot_code,
        l.lot_id::text AS lot_id,
        lot.lot_code,
        lot.lot_status,
        i.status AS inspection_status,
        i.decision AS inspection_decision,
        l.notes,
        l.created_at::text AS created_at,
        l.updated_at::text AS updated_at,
        l.created_by,
        l.updated_by
      FROM public.reception_fournisseur_lignes l
      LEFT JOIN public.articles a ON a.id = l.article_id
      LEFT JOIN public.lots lot ON lot.id = l.lot_id
      LEFT JOIN public.reception_incoming_inspections i ON i.reception_line_id = l.id
      WHERE l.reception_id = $1::uuid
      ORDER BY l.line_no ASC, l.id ASC
    `,
    [id]
  )

  const docs = await db.query<DocumentRow>(
    `
      SELECT
        id::text AS id,
        reception_id::text AS reception_id,
        reception_line_id::text AS reception_line_id,
        document_type,
        commentaire,
        original_name,
        stored_name,
        storage_path,
        mime_type,
        size_bytes::text AS size_bytes,
        sha256,
        label,
        uploaded_by,
        removed_at::text AS removed_at,
        removed_by,
        created_at::text AS created_at,
        updated_at::text AS updated_at,
        created_by,
        updated_by
      FROM public.reception_fournisseur_documents
      WHERE reception_id = $1::uuid
        AND removed_at IS NULL
      ORDER BY created_at DESC, id DESC
    `,
    [id]
  )

  const inspections = await db.query<InspectionRow>(
    `
      SELECT
        id::text AS id,
        reception_id::text AS reception_id,
        reception_line_id::text AS reception_line_id,
        lot_id::text AS lot_id,
        status,
        decision,
        decision_note,
        started_at::text AS started_at,
        decided_at::text AS decided_at,
        decided_by,
        created_at::text AS created_at,
        updated_at::text AS updated_at,
        created_by,
        updated_by
      FROM public.reception_incoming_inspections
      WHERE reception_id = $1::uuid
      ORDER BY started_at DESC, id DESC
    `,
    [id]
  )

  const inspectionIds = inspections.rows.map((x) => x.id)
  const measurementsByInspection = new Map<string, ReceptionIncomingMeasurement[]>()
  if (inspectionIds.length) {
    const meas = await db.query<MeasurementRow>(
      `
        SELECT
          id::text AS id,
          inspection_id::text AS inspection_id,
          characteristic,
          nominal_value::float8 AS nominal_value,
          tolerance_min::float8 AS tolerance_min,
          tolerance_max::float8 AS tolerance_max,
          measured_value::float8 AS measured_value,
          unit,
          result,
          comment,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
        FROM public.reception_incoming_measurements
        WHERE inspection_id = ANY($1::uuid[])
        ORDER BY created_at ASC, id ASC
      `,
      [inspectionIds]
    )

    for (const row of meas.rows) {
      const mapped = mapMeasurementRow(row)
      const cur = measurementsByInspection.get(mapped.inspection_id) ?? []
      cur.push(mapped)
      measurementsByInspection.set(mapped.inspection_id, cur)
    }
  }

  const receipts = await db.query<ReceiptRow>(
    `
      SELECT
        id::text AS id,
        reception_id::text AS reception_id,
        reception_line_id::text AS reception_line_id,
        stock_movement_id::text AS stock_movement_id,
        qty::float8 AS qty,
        created_at::text AS created_at,
        created_by
      FROM public.reception_fournisseur_stock_receipts
      WHERE reception_id = $1::uuid
      ORDER BY created_at DESC, id DESC
    `,
    [id]
  )

  return {
    reception: mapReceptionRow(r),
    lines: lines.rows.map(mapLineRow),
    documents: docs.rows.map(mapDocumentRow),
    inspections: inspections.rows.map((i) => mapInspectionRow(i, measurementsByInspection.get(i.id) ?? [])),
    stock_receipts: receipts.rows.map(mapReceiptRow),
  }
}

export async function repoCreateReception(body: CreateReceptionBodyDTO, audit: AuditContext): Promise<ReceptionFournisseur> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const receptionNo = await reserveReceptionNo(client)

    const ins = await client.query<ReceptionRow>(
      `
        INSERT INTO public.receptions_fournisseurs (
          reception_no,
          fournisseur_id,
          status,
          reception_date,
          supplier_reference,
          commentaire,
          created_by,
          updated_by
        )
        VALUES ($1,$2::uuid,'OPEN',$3::date,$4,$5,$6,$6)
        RETURNING
          id::text AS id,
          reception_no,
          fournisseur_id::text AS fournisseur_id,
          status,
          reception_date::text AS reception_date,
          supplier_reference,
          commentaire,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
      `,
      [
        receptionNo,
        body.fournisseur_id,
        body.reception_date ?? null,
        body.supplier_reference ?? null,
        body.commentaire ?? null,
        audit.user_id,
      ]
    )
    const row = ins.rows[0] ?? null
    if (!row) throw new Error("Failed to create reception")

    await insertAuditLog(client, audit, {
      action: "receptions.create",
      entity_type: "RECEPTION_FOURNISSEUR",
      entity_id: row.id,
      details: { reception_no: row.reception_no, fournisseur_id: row.fournisseur_id },
    })

    await client.query("COMMIT")
    return mapReceptionRow(row)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoPatchReception(id: string, patch: PatchReceptionBodyDTO, audit: AuditContext): Promise<ReceptionFournisseur | null> {
  const client = await db.connect()
  const sets: string[] = []
  const values: unknown[] = []
  const push = (v: unknown) => {
    values.push(v)
    return `$${values.length}`
  }

  if (patch.status !== undefined) sets.push(`status = ${push(patch.status)}`)
  if (patch.reception_date !== undefined) sets.push(`reception_date = ${push(patch.reception_date)}::date`)
  if (patch.supplier_reference !== undefined) sets.push(`supplier_reference = ${push(patch.supplier_reference ?? null)}`)
  if (patch.commentaire !== undefined) sets.push(`commentaire = ${push(patch.commentaire ?? null)}`)
  sets.push("updated_at = now()")
  sets.push(`updated_by = ${push(audit.user_id)}`)

  try {
    await client.query("BEGIN")
    const upd = await client.query<ReceptionRow>(
      `
        UPDATE public.receptions_fournisseurs
        SET ${sets.join(", ")}
        WHERE id = ${push(id)}::uuid
        RETURNING
          id::text AS id,
          reception_no,
          fournisseur_id::text AS fournisseur_id,
          status,
          reception_date::text AS reception_date,
          supplier_reference,
          commentaire,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
      `,
      values
    )
    const row = upd.rows[0] ?? null
    if (!row) {
      await client.query("ROLLBACK")
      return null
    }

    await insertAuditLog(client, audit, {
      action: "receptions.patch",
      entity_type: "RECEPTION_FOURNISSEUR",
      entity_id: id,
      details: { patch },
    })

    await client.query("COMMIT")
    return mapReceptionRow(row)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoCreateLine(receptionId: string, body: CreateLineBodyDTO, audit: AuditContext): Promise<ReceptionFournisseurLine | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const lockReception = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.receptions_fournisseurs WHERE id = $1::uuid FOR UPDATE`,
      [receptionId]
    )
    if (!lockReception.rows[0]?.ok) {
      await client.query("ROLLBACK")
      return null
    }

    const next = await client.query<{ next_no: number }>(
      `
        SELECT (COALESCE(MAX(line_no), 0) + 1)::int AS next_no
        FROM public.reception_fournisseur_lignes
        WHERE reception_id = $1::uuid
      `,
      [receptionId]
    )
    const lineNo = next.rows[0]?.next_no ?? 1

    const ins = await client.query<{ id: string }>(
      `
        INSERT INTO public.reception_fournisseur_lignes (
          reception_id,
          line_no,
          article_id,
          designation,
          qty_received,
          unite,
          supplier_lot_code,
          notes,
          created_by,
          updated_by
        )
        VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$9)
        RETURNING id::text AS id
      `,
      [
        receptionId,
        lineNo,
        body.article_id,
        body.designation ?? null,
        body.qty_received,
        body.unite ?? null,
        body.supplier_lot_code ?? null,
        body.notes ?? null,
        audit.user_id,
      ]
    )
    const lineId = ins.rows[0]?.id
    if (!lineId) throw new Error("Failed to create reception line")

    await insertAuditLog(client, audit, {
      action: "receptions.lines.create",
      entity_type: "RECEPTION_FOURNISSEUR_LINE",
      entity_id: lineId,
      details: { reception_id: receptionId, line_no: lineNo, article_id: body.article_id, qty_received: body.qty_received },
    })

    const detail = await selectLineDetail(client, lineId)

    await client.query("COMMIT")
    return detail
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

function formatYyyyMmDd(d: Date): string {
  const yyyy = String(d.getUTCFullYear())
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(d.getUTCDate()).padStart(2, "0")
  return `${yyyy}${mm}${dd}`
}

function generateLotCode(receptionNo: string, lineNo: number): string {
  const date = formatYyyyMmDd(new Date())
  const suffix = crypto.randomBytes(3).toString("hex")
  const raw = `MP-${receptionNo}-${lineNo}-${date}-${suffix}`
  return raw.length <= 80 ? raw : raw.slice(0, 80)
}

export async function repoCreateLotForLine(
  receptionId: string,
  lineId: string,
  body: CreateLotForLineBodyDTO,
  audit: AuditContext
): Promise<ReceptionFournisseurLine | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const row = await client.query<{
      id: string
      reception_id: string
      line_no: number
      article_id: string
      supplier_lot_code: string | null
      lot_id: string | null
      reception_no: string
    }>(
      `
        SELECT
          l.id::text AS id,
          l.reception_id::text AS reception_id,
          l.line_no,
          l.article_id::text AS article_id,
          l.supplier_lot_code,
          l.lot_id::text AS lot_id,
          r.reception_no
        FROM public.reception_fournisseur_lignes l
        JOIN public.receptions_fournisseurs r ON r.id = l.reception_id
        WHERE l.id = $1::uuid
          AND l.reception_id = $2::uuid
        FOR UPDATE
      `,
      [lineId, receptionId]
    )
    const line = row.rows[0] ?? null
    if (!line) {
      await client.query("ROLLBACK")
      return null
    }
    if (line.lot_id) throw new HttpError(409, "LOT_ALREADY_SET", "Un lot est deja rattache a cette ligne")

    const lotCode = body.lot_code?.trim() ? body.lot_code.trim() : generateLotCode(line.reception_no, line.line_no)
    const supplierLotCode = body.supplier_lot_code ?? line.supplier_lot_code ?? null

    let lotId: string
    try {
      const ins = await client.query<{ id: string }>(
        `
          INSERT INTO public.lots (
            article_id,
            lot_code,
            supplier_lot_code,
            received_at,
            manufactured_at,
            expiry_at,
            notes,
            lot_status,
            lot_status_note,
            created_by,
            updated_by
          )
          VALUES ($1::uuid,$2,$3,$4::date,$5::date,$6::date,$7,$8,$9,$10,$10)
          RETURNING id::text AS id
        `,
        [
          line.article_id,
          lotCode,
          supplierLotCode,
          body.received_at ?? null,
          body.manufactured_at ?? null,
          body.expiry_at ?? null,
          body.notes ?? null,
          "EN_ATTENTE",
          null,
          audit.user_id,
        ]
      )
      lotId = ins.rows[0]?.id ?? ""
      if (!lotId) throw new Error("Failed to create lot")
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw new HttpError(409, "LOT_EXISTS", "Un lot avec ce numero existe deja pour cet article")
      }
      throw err
    }

    await client.query(
      `
        UPDATE public.reception_fournisseur_lignes
        SET
          lot_id = $1::uuid,
          supplier_lot_code = COALESCE(supplier_lot_code, $2),
          updated_at = now(),
          updated_by = $3
        WHERE id = $4::uuid
      `,
      [lotId, supplierLotCode, audit.user_id, lineId]
    )

    await insertAuditLog(client, audit, {
      action: "receptions.lines.create_lot",
      entity_type: "lots",
      entity_id: lotId,
      details: { reception_id: receptionId, line_id: lineId, lot_code: lotCode, lot_status: "EN_ATTENTE" },
    })

    const detail = await selectLineDetail(client, lineId)

    await client.query("COMMIT")
    return detail
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoAttachDocuments(
  receptionId: string,
  body: AttachDocumentsBodyDTO,
  documents: UploadedDocument[],
  audit: AuditContext
): Promise<ReceptionFournisseurDocument[] | null> {
  const client = await db.connect()
  const docsDirRel = path.posix.join("uploads", "docs", "receptions")
  const docsDirAbs = path.resolve(docsDirRel)
  const movedFiles: string[] = []
  try {
    await client.query("BEGIN")
    const exists = await ensureReceptionExists(client, receptionId)
    if (!exists) {
      await client.query("ROLLBACK")
      return null
    }

    if (body.reception_line_id) {
      const line = await client.query<{ ok: number }>(
        `
          SELECT 1::int AS ok
          FROM public.reception_fournisseur_lignes
          WHERE id = $1::uuid AND reception_id = $2::uuid
          LIMIT 1
        `,
        [body.reception_line_id, receptionId]
      )
      if (!line.rows[0]?.ok) throw new HttpError(400, "INVALID_LINE", "Ligne de reception introuvable")
    }

    if (!documents.length) {
      await client.query("COMMIT")
      return []
    }

    await fs.mkdir(docsDirAbs, { recursive: true })
    const inserted: ReceptionFournisseurDocument[] = []

    for (const doc of documents) {
      const documentId = crypto.randomUUID()
      const safeExt = safeDocExtension(doc.originalname)
      const storedName = `${documentId}${safeExt}`
      const relPath = toPosixPath(path.join(docsDirRel, storedName))
      const absPath = path.join(docsDirAbs, storedName)
      const tempPath = path.resolve(doc.path)

      try {
        await fs.rename(tempPath, absPath)
      } catch {
        await fs.copyFile(tempPath, absPath)
        await fs.unlink(tempPath)
      }

      movedFiles.push(absPath)
      const hash = await sha256File(absPath)

      const ins = await client.query<DocumentRow>(
        `
          INSERT INTO public.reception_fournisseur_documents (
            reception_id,
            reception_line_id,
            document_type,
            commentaire,
            original_name,
            stored_name,
            storage_path,
            mime_type,
            size_bytes,
            sha256,
            label,
            uploaded_by,
            created_by,
            updated_by
          )
          VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12)
          RETURNING
            id::text AS id,
            reception_id::text AS reception_id,
            reception_line_id::text AS reception_line_id,
            document_type,
            commentaire,
            original_name,
            stored_name,
            storage_path,
            mime_type,
            size_bytes::text AS size_bytes,
            sha256,
            label,
            uploaded_by,
            removed_at::text AS removed_at,
            removed_by,
            created_at::text AS created_at,
            updated_at::text AS updated_at,
            created_by,
            updated_by
        `,
        [
          receptionId,
          body.reception_line_id ?? null,
          body.document_type,
          body.commentaire ?? null,
          doc.originalname,
          storedName,
          relPath,
          doc.mimetype,
          doc.size,
          hash,
          body.label ?? null,
          audit.user_id,
        ]
      )
      const row = ins.rows[0] ?? null
      if (!row) throw new Error("Failed to insert reception document")
      inserted.push(mapDocumentRow(row))
    }

    await insertAuditLog(client, audit, {
      action: "receptions.documents.attach",
      entity_type: "RECEPTION_FOURNISSEUR",
      entity_id: receptionId,
      details: {
        document_type: body.document_type,
        line_id: body.reception_line_id ?? null,
        count: inserted.length,
        documents: inserted.map((d) => ({ id: d.id, original_name: d.original_name, mime_type: d.mime_type, size_bytes: d.size_bytes })),
      },
    })

    await client.query("COMMIT")
    return inserted
  } catch (err) {
    await client.query("ROLLBACK")
    for (const f of movedFiles) await fs.unlink(f).catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

export async function repoRemoveDocument(receptionId: string, documentId: string, audit: AuditContext): Promise<boolean | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const exists = await ensureReceptionExists(client, receptionId)
    if (!exists) {
      await client.query("ROLLBACK")
      return null
    }

    const current = await client.query<Pick<DocumentRow, "original_name" | "storage_path">>(
      `
        SELECT original_name, storage_path
        FROM public.reception_fournisseur_documents
        WHERE id = $1::uuid AND reception_id = $2::uuid AND removed_at IS NULL
        FOR UPDATE
      `,
      [documentId, receptionId]
    )
    const doc = current.rows[0] ?? null
    if (!doc) {
      await client.query("ROLLBACK")
      return false
    }

    const upd = await client.query(
      `
        UPDATE public.reception_fournisseur_documents
        SET removed_at = now(), removed_by = $3, updated_at = now(), updated_by = $3
        WHERE id = $1::uuid AND reception_id = $2::uuid AND removed_at IS NULL
      `,
      [documentId, receptionId, audit.user_id]
    )
    if ((upd.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK")
      return false
    }

    await insertAuditLog(client, audit, {
      action: "receptions.documents.remove",
      entity_type: "RECEPTION_FOURNISSEUR_DOCUMENT",
      entity_id: documentId,
      details: { reception_id: receptionId, original_name: doc.original_name, storage_path: doc.storage_path },
    })

    await client.query("COMMIT")
    return true
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoGetDocumentForDownload(
  receptionId: string,
  documentId: string,
  audit: AuditContext
): Promise<ReceptionFournisseurDocument | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const exists = await ensureReceptionExists(client, receptionId)
    if (!exists) {
      await client.query("ROLLBACK")
      return null
    }

    const res = await client.query<DocumentRow>(
      `
        SELECT
          id::text AS id,
          reception_id::text AS reception_id,
          reception_line_id::text AS reception_line_id,
          document_type,
          commentaire,
          original_name,
          stored_name,
          storage_path,
          mime_type,
          size_bytes::text AS size_bytes,
          sha256,
          label,
          uploaded_by,
          removed_at::text AS removed_at,
          removed_by,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
        FROM public.reception_fournisseur_documents
        WHERE id = $1::uuid
          AND reception_id = $2::uuid
          AND removed_at IS NULL
        LIMIT 1
      `,
      [documentId, receptionId]
    )
    const row = res.rows[0] ?? null
    if (!row) {
      await client.query("ROLLBACK")
      return null
    }

    await insertAuditLog(client, audit, {
      action: "receptions.documents.download",
      entity_type: "RECEPTION_FOURNISSEUR_DOCUMENT",
      entity_id: documentId,
      details: { reception_id: receptionId, original_name: row.original_name },
    })

    await client.query("COMMIT")
    return mapDocumentRow(row)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoStartInspection(receptionId: string, lineId: string, audit: AuditContext): Promise<ReceptionIncomingInspection | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const lineRes = await client.query<{ lot_id: string | null }>(
      `
        SELECT l.lot_id::text AS lot_id
        FROM public.reception_fournisseur_lignes l
        WHERE l.id = $1::uuid AND l.reception_id = $2::uuid
        FOR UPDATE
      `,
      [lineId, receptionId]
    )
    const line = lineRes.rows[0] ?? null
    if (!line) {
      await client.query("ROLLBACK")
      return null
    }
    if (!line.lot_id) throw new HttpError(409, "LOT_REQUIRED", "Veuillez d'abord creer le lot avant de demarrer le controle")

    const existing = await client.query<InspectionRow>(
      `
        SELECT
          id::text AS id,
          reception_id::text AS reception_id,
          reception_line_id::text AS reception_line_id,
          lot_id::text AS lot_id,
          status,
          decision,
          decision_note,
          started_at::text AS started_at,
          decided_at::text AS decided_at,
          decided_by,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
        FROM public.reception_incoming_inspections
        WHERE reception_line_id = $1::uuid
        LIMIT 1
        FOR UPDATE
      `,
      [lineId]
    )
    const cur = existing.rows[0] ?? null
    if (cur) {
      await client.query("COMMIT")
      const meas = await db.query<MeasurementRow>(
        `
          SELECT
            id::text AS id,
            inspection_id::text AS inspection_id,
            characteristic,
            nominal_value::float8 AS nominal_value,
            tolerance_min::float8 AS tolerance_min,
            tolerance_max::float8 AS tolerance_max,
            measured_value::float8 AS measured_value,
            unit,
            result,
            comment,
            created_at::text AS created_at,
            updated_at::text AS updated_at,
            created_by,
            updated_by
          FROM public.reception_incoming_measurements
          WHERE inspection_id = $1::uuid
          ORDER BY created_at ASC, id ASC
        `,
        [cur.id]
      )
      return mapInspectionRow(cur, meas.rows.map(mapMeasurementRow))
    }

    const ins = await client.query<{ id: string }>(
      `
        INSERT INTO public.reception_incoming_inspections (
          reception_id,
          reception_line_id,
          lot_id,
          status,
          started_at,
          created_by,
          updated_by
        )
        VALUES ($1::uuid,$2::uuid,$3::uuid,'IN_PROGRESS',now(),$4,$4)
        RETURNING id::text AS id
      `,
      [receptionId, lineId, line.lot_id, audit.user_id]
    )
    const inspectionId = ins.rows[0]?.id
    if (!inspectionId) throw new Error("Failed to start inspection")

    await insertAuditLog(client, audit, {
      action: "receptions.inspections.start",
      entity_type: "RECEPTION_INCOMING_INSPECTION",
      entity_id: inspectionId,
      details: { reception_id: receptionId, line_id: lineId, lot_id: line.lot_id },
    })

    await client.query("COMMIT")
    const after = await db.query<InspectionRow>(
      `
        SELECT
          id::text AS id,
          reception_id::text AS reception_id,
          reception_line_id::text AS reception_line_id,
          lot_id::text AS lot_id,
          status,
          decision,
          decision_note,
          started_at::text AS started_at,
          decided_at::text AS decided_at,
          decided_by,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
        FROM public.reception_incoming_inspections
        WHERE id = $1::uuid
      `,
      [inspectionId]
    )
    const i = after.rows[0] ?? null
    if (!i) throw new Error("Failed to read started inspection")
    return mapInspectionRow(i, [])
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoAddMeasurement(
  receptionId: string,
  lineId: string,
  body: AddMeasurementBodyDTO,
  audit: AuditContext
): Promise<ReceptionIncomingMeasurement | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const inspectionRes = await client.query<{ id: string; status: string }>(
      `
        SELECT i.id::text AS id, i.status
        FROM public.reception_incoming_inspections i
        WHERE i.reception_id = $1::uuid AND i.reception_line_id = $2::uuid
        LIMIT 1
        FOR UPDATE
      `,
      [receptionId, lineId]
    )
    const inspection = inspectionRes.rows[0] ?? null
    if (!inspection) throw new HttpError(409, "INSPECTION_NOT_STARTED", "Le controle n'a pas ete demarre")
    if (inspection.status === "DECIDED") throw new HttpError(409, "INSPECTION_DECIDED", "Le controle est deja termine")

    const ins = await client.query<MeasurementRow>(
      `
        INSERT INTO public.reception_incoming_measurements (
          inspection_id,
          characteristic,
          nominal_value,
          tolerance_min,
          tolerance_max,
          measured_value,
          unit,
          result,
          comment,
          created_by,
          updated_by
        )
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
        RETURNING
          id::text AS id,
          inspection_id::text AS inspection_id,
          characteristic,
          nominal_value::float8 AS nominal_value,
          tolerance_min::float8 AS tolerance_min,
          tolerance_max::float8 AS tolerance_max,
          measured_value::float8 AS measured_value,
          unit,
          result,
          comment,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
      `,
      [
        inspection.id,
        body.characteristic,
        body.nominal_value ?? null,
        body.tolerance_min ?? null,
        body.tolerance_max ?? null,
        body.measured_value ?? null,
        body.unit ?? null,
        body.result ?? null,
        body.comment ?? null,
        audit.user_id,
      ]
    )
    const row = ins.rows[0] ?? null
    if (!row) throw new Error("Failed to create measurement")

    await insertAuditLog(client, audit, {
      action: "receptions.inspections.measurements.add",
      entity_type: "RECEPTION_INCOMING_MEASUREMENT",
      entity_id: row.id,
      details: { reception_id: receptionId, line_id: lineId, inspection_id: inspection.id, characteristic: row.characteristic },
    })

    await client.query("COMMIT")
    return mapMeasurementRow(row)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoDecideInspection(
  receptionId: string,
  lineId: string,
  body: DecideInspectionBodyDTO,
  audit: AuditContext
): Promise<ReceptionIncomingInspection | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const lock = await client.query<InspectionRow>(
      `
        SELECT
          id::text AS id,
          reception_id::text AS reception_id,
          reception_line_id::text AS reception_line_id,
          lot_id::text AS lot_id,
          status,
          decision,
          decision_note,
          started_at::text AS started_at,
          decided_at::text AS decided_at,
          decided_by,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
        FROM public.reception_incoming_inspections
        WHERE reception_id = $1::uuid AND reception_line_id = $2::uuid
        LIMIT 1
        FOR UPDATE
      `,
      [receptionId, lineId]
    )
    const inspection = lock.rows[0] ?? null
    if (!inspection) throw new HttpError(409, "INSPECTION_NOT_STARTED", "Le controle n'a pas ete demarre")
    if (inspection.status === "DECIDED") throw new HttpError(409, "INSPECTION_ALREADY_DECIDED", "Une decision a deja ete prise")

    await client.query(
      `
        UPDATE public.reception_incoming_inspections
        SET
          status = 'DECIDED',
          decision = $2,
          decision_note = $3,
          decided_at = now(),
          decided_by = $4,
          updated_at = now(),
          updated_by = $4
        WHERE id = $1::uuid
      `,
      [inspection.id, body.decision, body.decision_note ?? null, audit.user_id]
    )

    await client.query(
      `
        UPDATE public.lots
        SET
          lot_status = $2,
          lot_status_note = $3,
          updated_at = now(),
          updated_by = $4
        WHERE id = $1::uuid
      `,
      [inspection.lot_id, body.decision, body.decision_note ?? null, audit.user_id]
    )

    await insertAuditLog(client, audit, {
      action: "receptions.inspections.decide",
      entity_type: "RECEPTION_INCOMING_INSPECTION",
      entity_id: inspection.id,
      details: { reception_id: receptionId, line_id: lineId, lot_id: inspection.lot_id, decision: body.decision },
    })

    await client.query("COMMIT")

    const after = await db.query<InspectionRow>(
      `
        SELECT
          id::text AS id,
          reception_id::text AS reception_id,
          reception_line_id::text AS reception_line_id,
          lot_id::text AS lot_id,
          status,
          decision,
          decision_note,
          started_at::text AS started_at,
          decided_at::text AS decided_at,
          decided_by,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
        FROM public.reception_incoming_inspections
        WHERE id = $1::uuid
      `,
      [inspection.id]
    )
    const i = after.rows[0] ?? null
    if (!i) throw new Error("Failed to read decided inspection")
    const meas = await db.query<MeasurementRow>(
      `
        SELECT
          id::text AS id,
          inspection_id::text AS inspection_id,
          characteristic,
          nominal_value::float8 AS nominal_value,
          tolerance_min::float8 AS tolerance_min,
          tolerance_max::float8 AS tolerance_max,
          measured_value::float8 AS measured_value,
          unit,
          result,
          comment,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
        FROM public.reception_incoming_measurements
        WHERE inspection_id = $1::uuid
        ORDER BY created_at ASC, id ASC
      `,
      [inspection.id]
    )
    return mapInspectionRow(i, meas.rows.map(mapMeasurementRow))
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

async function sumReceiptedQty(lineId: string): Promise<number> {
  const res = await db.query<{ qty: number }>(
    `
      SELECT COALESCE(SUM(qty), 0)::float8 AS qty
      FROM public.reception_fournisseur_stock_receipts
      WHERE reception_line_id = $1::uuid
    `,
    [lineId]
  )
  return res.rows[0]?.qty ?? 0
}

export async function repoCreateStockReceipt(
  receptionId: string,
  lineId: string,
  body: StockReceiptBodyDTO,
  audit: AuditContext
): Promise<{ stock_movement_id: string; movement_no: string | null; posted: StockMovementDetail } | null> {
  const lineRes = await db.query<{
    id: string
    qty_received: number
    article_id: string
    unite: string | null
    lot_id: string | null
    lot_status: string | null
    reception_no: string
  }>(
    `
      SELECT
        l.id::text AS id,
        l.qty_received::float8 AS qty_received,
        l.article_id::text AS article_id,
        l.unite,
        l.lot_id::text AS lot_id,
        lot.lot_status,
        r.reception_no
      FROM public.reception_fournisseur_lignes l
      JOIN public.receptions_fournisseurs r ON r.id = l.reception_id
      LEFT JOIN public.lots lot ON lot.id = l.lot_id
      WHERE l.id = $1::uuid AND l.reception_id = $2::uuid
      LIMIT 1
    `,
    [lineId, receptionId]
  )
  const line = lineRes.rows[0] ?? null
  if (!line) return null
  if (!line.lot_id) throw new HttpError(409, "LOT_REQUIRED", "Veuillez d'abord creer le lot")

  const lotStatus = line.lot_status ?? "LIBERE"
  if (lotStatus !== "LIBERE") {
    throw new HttpError(409, "LOT_NOT_RELEASED", "Mise en stock impossible: le lot n'est pas libere")
  }

  const already = await sumReceiptedQty(lineId)
  const remaining = (line.qty_received ?? 0) - already
  if (body.qty > remaining + 1e-9) {
    throw new HttpError(409, "OVER_RECEIPT", "Quantite superieure a la quantite restante a mettre en stock")
  }

  const created = await repoCreateMovement(
    {
      movement_type: "IN",
      effective_at: body.effective_at ?? null,
      source_document_type: "RECEPTION_FOURNISSEUR",
      source_document_id: receptionId,
      reason_code: "RECEPTION_FOURNISSEUR",
      notes: body.notes ?? `Reception ${line.reception_no}`,
      idempotency_key: null,
      lines: [
        {
          article_id: line.article_id,
          lot_id: line.lot_id,
          qty: body.qty,
          unite: body.unite ?? line.unite ?? null,
          unit_cost: null,
          currency: null,
          src_magasin_id: null,
          src_emplacement_id: null,
          dst_magasin_id: body.dst_magasin_id,
          dst_emplacement_id: body.dst_emplacement_id,
          note: null,
        },
      ],
    },
    audit
  )

  const posted = await repoPostMovement(created.movement.id, audit)
  if (!posted) throw new Error("Failed to post stock movement")

  await db.query(
    `
      INSERT INTO public.reception_fournisseur_stock_receipts (
        reception_id,
        reception_line_id,
        stock_movement_id,
        qty,
        created_by
      )
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5)
    `,
    [receptionId, lineId, posted.movement.id, body.qty, audit.user_id]
  )

  await insertAuditLog(db, audit, {
    action: "receptions.stock_receipt",
    entity_type: "stock_movements",
    entity_id: posted.movement.id,
    details: { reception_id: receptionId, line_id: lineId, movement_no: posted.movement.movement_no, qty: body.qty },
  })

  return {
    stock_movement_id: posted.movement.id,
    movement_no: posted.movement.movement_no,
    posted,
  }
}
