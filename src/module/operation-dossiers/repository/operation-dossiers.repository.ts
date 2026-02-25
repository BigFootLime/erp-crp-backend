import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { PoolClient } from "pg"

import pool from "../../../config/database"
import { HttpError } from "../../../utils/httpError"
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators"
import type {
  CreateOperationDossierVersionResult,
  OperationDossierHeader,
  OperationDossierOperationResponse,
  OperationDossierType,
  OperationDossierVersion,
  OperationDossierVersionDocument,
  OperationDossierOperationType,
  UserLite,
} from "../types/operation-dossiers.types"

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

type UploadedDocument = Express.Multer.File

type SlotOverride = { has: boolean; value: string | null }

type SlotDocumentBaseline = {
  slot_key: string
  label: string | null
  commentaire: string | null
  document_id: string | null
  mime_type: string | null
  file_name: string | null
  file_size_bytes: string | number | null
}

const TECHNIQUE_SLOTS = [
  "DOC_01",
  "DOC_02",
  "DOC_03",
  "DOC_04",
  "DOC_05",
  "DOC_06",
  "DOC_07",
  "DOC_08",
] as const

const PROGRAMMATION_SLOTS = ["DOC_01", "DOC_02", "DOC_03", "DOC_04", "DOC_05", "DOC_06"] as const

function slotKeysForType(dossierType: OperationDossierType): readonly string[] {
  return dossierType === "PROGRAMMATION" ? PROGRAMMATION_SLOTS : TECHNIQUE_SLOTS
}

function defaultSlotLabel(dossierType: OperationDossierType, slotKey: string): string {
  if (dossierType === "PROGRAMMATION") {
    switch (slotKey) {
      case "DOC_01":
        return "Fichier Mastercam (.mcam)"
      case "DOC_02":
        return "Post-proc / paramètres"
      case "DOC_03":
        return "Fiche de réglage"
      case "DOC_04":
        return "Programme CN export"
      case "DOC_05":
        return "Notes programmeur"
      case "DOC_06":
      default:
        return "Autres"
    }
  }

  const m = /^DOC_(\d{2})$/.exec(slotKey)
  const n = m ? Number(m[1]) : NaN
  if (Number.isFinite(n) && n > 0) return `Document ${n}`
  return "Document"
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
  return { id: row.id, username: row.username, name: row.name, surname: row.surname, label }
}

function safeExtFromName(name: string): string {
  const extCandidate = path.extname(name).toLowerCase()
  return /^\.[a-z0-9]+$/.test(extCandidate) && extCandidate.length <= 10 ? extCandidate : ""
}

function resolveMimeType(value: string | null | undefined): string {
  const t = String(value ?? "").trim().toLowerCase()
  if (!t) return "application/octet-stream"
  if (t.includes("/")) return t
  if (t === "pdf" || t.includes("pdf")) return "application/pdf"
  return "application/octet-stream"
}

async function ensureDocsDir(): Promise<string> {
  const baseDir = path.resolve("uploads/docs/operation-dossiers")
  await fs.mkdir(baseDir, { recursive: true })
  return baseDir
}

async function insertAuditLog(tx: Pick<PoolClient, "query">, audit: AuditContext, entry: {
  action: string
  entity_id: string
  details?: Record<string, unknown> | null
}) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: "OPERATION_DOSSIER",
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

type DossierRow = {
  id: string
  operation_type: string
  operation_id: string
  dossier_type: string
  title: string | null
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

function mapHeaderRow(r: DossierRow): OperationDossierHeader {
  return {
    id: r.id,
    operation_type: r.operation_type === "OF_OPERATION" ? "OF_OPERATION" : "PIECE_TECHNIQUE_OPERATION",
    operation_id: r.operation_id,
    dossier_type: r.dossier_type === "PROGRAMMATION" ? "PROGRAMMATION" : "TECHNIQUE",
    title: r.title,
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
}

export async function repoUpsertOperationDossier(params: {
  operation_type: OperationDossierOperationType
  operation_id: string
  dossier_type: OperationDossierType
  title?: string | null
  audit: AuditContext
}): Promise<OperationDossierHeader> {
  const opId = params.operation_id.trim()
  const title = params.title?.trim() ? params.title.trim() : null
  const db = await pool.connect()
  try {
    const res = await db.query<DossierRow>(
      `
        WITH upsert AS (
          INSERT INTO public.operation_dossiers (
            operation_type,
            operation_id,
            dossier_type,
            title,
            created_by,
            updated_by
          )
          VALUES ($1,$2,$3,$4,$5,$5)
          ON CONFLICT (operation_type, operation_id, dossier_type)
          DO UPDATE SET
            title = COALESCE(EXCLUDED.title, public.operation_dossiers.title),
            updated_at = now(),
            updated_by = EXCLUDED.updated_by
          RETURNING
            id,
            operation_type,
            operation_id,
            dossier_type,
            title,
            created_at,
            updated_at,
            created_by,
            updated_by
        )
        SELECT
          u.id::text AS id,
          u.operation_type,
          u.operation_id,
          u.dossier_type,
          u.title,
          u.created_at::text AS created_at,
          u.updated_at::text AS updated_at,
          cb.id AS created_by_id,
          cb.username AS created_by_username,
          cb.name AS created_by_name,
          cb.surname AS created_by_surname,
          ub.id AS updated_by_id,
          ub.username AS updated_by_username,
          ub.name AS updated_by_name,
          ub.surname AS updated_by_surname
        FROM upsert u
        LEFT JOIN public.users cb ON cb.id = u.created_by
        LEFT JOIN public.users ub ON ub.id = u.updated_by
      `,
      [params.operation_type, opId, params.dossier_type, title, params.audit.user_id]
    )

    const row = res.rows[0] ?? null
    if (!row) throw new Error("Failed to upsert operation dossier")
    return mapHeaderRow(row)
  } finally {
    db.release()
  }
}

type VersionRow = {
  id: string
  dossier_id: string
  version: number
  commentaire: string | null
  created_at: string
  created_by_id: number | null
  created_by_username: string | null
  created_by_name: string | null
  created_by_surname: string | null
}

type VersionDocRow = {
  id: string
  dossier_version_id: string
  slot_key: string
  label: string | null
  commentaire: string | null
  document_id: string | null
  mime_type: string | null
  file_name: string | null
  file_size_bytes: string | number | null
  created_at: string
  updated_at: string
}

function toInt64(value: string | number | null): number | null {
  if (value === null) return null
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value)
  return null
}

function mapVersionDocRow(r: VersionDocRow): OperationDossierVersionDocument {
  return {
    id: r.id,
    dossier_version_id: r.dossier_version_id,
    slot_key: r.slot_key,
    label: r.label,
    commentaire: r.commentaire,
    document_id: r.document_id,
    mime_type: r.mime_type,
    file_name: r.file_name,
    file_size_bytes: toInt64(r.file_size_bytes),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

export async function repoGetOperationDossierTimeline(dossierId: string): Promise<{ dossier: OperationDossierHeader; versions: OperationDossierVersion[] }> {
  const headerRes = await pool.query<DossierRow>(
    `
      SELECT
        d.id::text AS id,
        d.operation_type,
        d.operation_id,
        d.dossier_type,
        d.title,
        d.created_at::text AS created_at,
        d.updated_at::text AS updated_at,
        cb.id AS created_by_id,
        cb.username AS created_by_username,
        cb.name AS created_by_name,
        cb.surname AS created_by_surname,
        ub.id AS updated_by_id,
        ub.username AS updated_by_username,
        ub.name AS updated_by_name,
        ub.surname AS updated_by_surname
      FROM public.operation_dossiers d
      LEFT JOIN public.users cb ON cb.id = d.created_by
      LEFT JOIN public.users ub ON ub.id = d.updated_by
      WHERE d.id = $1::uuid
      LIMIT 1
    `,
    [dossierId]
  )

  const headerRow = headerRes.rows[0] ?? null
  if (!headerRow) throw new HttpError(404, "DOSSIER_NOT_FOUND", "Dossier not found")
  const dossier = mapHeaderRow(headerRow)

  const versionsRes = await pool.query<VersionRow>(
    `
      SELECT
        v.id::text AS id,
        v.dossier_id::text AS dossier_id,
        v.version,
        v.commentaire,
        v.created_at::text AS created_at,
        u.id AS created_by_id,
        u.username AS created_by_username,
        u.name AS created_by_name,
        u.surname AS created_by_surname
      FROM public.operation_dossier_versions v
      LEFT JOIN public.users u ON u.id = v.created_by
      WHERE v.dossier_id = $1::uuid
      ORDER BY v.version DESC, v.created_at DESC, v.id DESC
      LIMIT 200
    `,
    [dossierId]
  )

  const versionIds = versionsRes.rows.map((v) => v.id)
  const docsRes = versionIds.length
    ? await pool.query<VersionDocRow>(
        `
          SELECT
            d.id::text AS id,
            d.dossier_version_id::text AS dossier_version_id,
            d.slot_key,
            d.label,
            d.commentaire,
            d.document_id::text AS document_id,
            d.mime_type,
            d.file_name,
            d.file_size_bytes,
            d.created_at::text AS created_at,
            d.updated_at::text AS updated_at
          FROM public.operation_dossier_version_documents d
          WHERE d.dossier_version_id = ANY($1::uuid[])
          ORDER BY d.dossier_version_id ASC, d.slot_key ASC
        `,
        [versionIds]
      )
    : { rows: [] as VersionDocRow[] }

  const docsByVersionId = new Map<string, OperationDossierVersionDocument[]>()
  for (const r of docsRes.rows) {
    const mapped = mapVersionDocRow(r)
    const arr = docsByVersionId.get(mapped.dossier_version_id) ?? []
    arr.push(mapped)
    docsByVersionId.set(mapped.dossier_version_id, arr)
  }

  const versions: OperationDossierVersion[] = versionsRes.rows.map((r) => ({
    id: r.id,
    dossier_id: r.dossier_id,
    version: r.version,
    commentaire: r.commentaire,
    created_at: r.created_at,
    created_by: mapUserLite({
      id: r.created_by_id,
      username: r.created_by_username,
      name: r.created_by_name,
      surname: r.created_by_surname,
    }),
    documents: docsByVersionId.get(r.id) ?? [],
  }))

  return { dossier, versions }
}

async function repoGetDossierForUpdate(tx: Pick<PoolClient, "query">, dossierId: string): Promise<{ id: string; operation_type: OperationDossierOperationType; operation_id: string; dossier_type: OperationDossierType }> {
  const res = await tx.query<{ id: string; operation_type: string; operation_id: string; dossier_type: string }>(
    `
      SELECT
        id::text AS id,
        operation_type,
        operation_id,
        dossier_type
      FROM public.operation_dossiers
      WHERE id = $1::uuid
      FOR UPDATE
    `,
    [dossierId]
  )

  const row = res.rows[0] ?? null
  if (!row) throw new HttpError(404, "DOSSIER_NOT_FOUND", "Dossier not found")
  const operation_type: OperationDossierOperationType = row.operation_type === "OF_OPERATION" ? "OF_OPERATION" : "PIECE_TECHNIQUE_OPERATION"
  const dossier_type: OperationDossierType = row.dossier_type === "PROGRAMMATION" ? "PROGRAMMATION" : "TECHNIQUE"
  return { id: row.id, operation_type, operation_id: row.operation_id, dossier_type }
}

async function repoGetLatestVersionBaseline(tx: Pick<PoolClient, "query">, dossierId: string): Promise<{ id: string; version: number; docsBySlot: Map<string, SlotDocumentBaseline> } | null> {
  const vRes = await tx.query<{ id: string; version: number }>(
    `
      SELECT id::text AS id, version
      FROM public.operation_dossier_versions
      WHERE dossier_id = $1::uuid
      ORDER BY version DESC, created_at DESC, id DESC
      LIMIT 1
    `,
    [dossierId]
  )

  const v = vRes.rows[0] ?? null
  if (!v) return null

  const dRes = await tx.query<SlotDocumentBaseline>(
    `
      SELECT
        slot_key,
        label,
        commentaire,
        document_id::text AS document_id,
        mime_type,
        file_name,
        file_size_bytes
      FROM public.operation_dossier_version_documents
      WHERE dossier_version_id = $1::uuid
      ORDER BY slot_key ASC
    `,
    [v.id]
  )

  const docsBySlot = new Map<string, SlotDocumentBaseline>()
  for (const r of dRes.rows) docsBySlot.set(r.slot_key, r)
  return { id: v.id, version: v.version, docsBySlot }
}

export async function repoCreateOperationDossierVersion(params: {
  dossier_id: string
  commentaire: string | null
  uploadsBySlot: Map<string, UploadedDocument>
  labelBySlot: Map<string, SlotOverride>
  docCommentBySlot: Map<string, SlotOverride>
  audit: AuditContext
}): Promise<CreateOperationDossierVersionResult> {
  const docsDir = await ensureDocsDir()
  const tx = await pool.connect()
  const movedFiles: string[] = []

  try {
    await tx.query("BEGIN")

    const dossier = await repoGetDossierForUpdate(tx, params.dossier_id)
    const baseline = await repoGetLatestVersionBaseline(tx, params.dossier_id)

    const nextVersion = baseline ? baseline.version + 1 : 1
    const versionIns = await tx.query<{ id: string; dossier_id: string; version: number }>(
      `
        INSERT INTO public.operation_dossier_versions (dossier_id, version, commentaire, created_by)
        VALUES ($1::uuid, $2, $3, $4)
        RETURNING id::text AS id, dossier_id::text AS dossier_id, version
      `,
      [params.dossier_id, nextVersion, params.commentaire, params.audit.user_id]
    )

    const versionRow = versionIns.rows[0] ?? null
    if (!versionRow) throw new Error("Failed to create operation dossier version")

    const allowedSlots = slotKeysForType(dossier.dossier_type)
    const docsBySlot = baseline?.docsBySlot ?? new Map<string, SlotDocumentBaseline>()

    const replacedSlots: string[] = []

    for (const slotKey of allowedSlots) {
      const prev = docsBySlot.get(slotKey) ?? null
      const file = params.uploadsBySlot.get(slotKey) ?? null

      const labelOverride = params.labelBySlot.get(slotKey) ?? { has: false, value: null }
      const docCommentOverride = params.docCommentBySlot.get(slotKey) ?? { has: false, value: null }

      const nextLabel =
        labelOverride.has
          ? (labelOverride.value?.trim() ? labelOverride.value.trim() : null)
          : prev?.label ?? defaultSlotLabel(dossier.dossier_type, slotKey)

      const nextDocComment =
        docCommentOverride.has
          ? (docCommentOverride.value?.trim() ? docCommentOverride.value.trim() : null)
          : prev?.commentaire ?? null

      let nextDocumentId: string | null = prev?.document_id ?? null
      let nextMimeType: string | null = prev?.mime_type ?? null
      let nextFileName: string | null = prev?.file_name ?? null
      let nextSizeBytes: number | null = prev ? toInt64(prev.file_size_bytes) : null

      if (file) {
        replacedSlots.push(slotKey)
        const documentId = crypto.randomUUID()
        const safeExt = safeExtFromName(file.originalname)
        const finalPath = path.join(docsDir, `${documentId}${safeExt}`)

        try {
          await fs.rename(file.path, finalPath)
        } catch {
          await fs.copyFile(file.path, finalPath)
          await fs.unlink(file.path)
        }
        movedFiles.push(finalPath)

        await tx.query(`INSERT INTO public.documents_clients (id, document_name, type) VALUES ($1, $2, $3)`, [
          documentId,
          file.originalname,
          file.mimetype,
        ])

        nextDocumentId = documentId
        nextMimeType = file.mimetype
        nextFileName = file.originalname
        nextSizeBytes = typeof file.size === "number" && Number.isFinite(file.size) ? file.size : null
      }

      await tx.query(
        `
          INSERT INTO public.operation_dossier_version_documents (
            dossier_version_id,
            slot_key,
            label,
            commentaire,
            document_id,
            mime_type,
            file_name,
            file_size_bytes,
            created_by,
            updated_by
          )
          VALUES ($1::uuid,$2,$3,$4,$5::uuid,$6,$7,$8,$9,$9)
        `,
        [
          versionRow.id,
          slotKey,
          nextLabel,
          nextDocComment,
          nextDocumentId,
          nextMimeType,
          nextFileName,
          nextSizeBytes,
          params.audit.user_id,
        ]
      )
    }

    await tx.query(`UPDATE public.operation_dossiers SET updated_at = now(), updated_by = $2 WHERE id = $1::uuid`, [
      params.dossier_id,
      params.audit.user_id,
    ])

    await insertAuditLog(tx, params.audit, {
      action: "dossier.version.created",
      entity_id: params.dossier_id,
      details: {
        version: versionRow.version,
        operation_type: dossier.operation_type,
        operation_id: dossier.operation_id,
        dossier_type: dossier.dossier_type,
        replaced_slots: replacedSlots,
      },
    })

    await tx.query("COMMIT")
    return { id: versionRow.id, dossier_id: versionRow.dossier_id, version: versionRow.version }
  } catch (err) {
    await tx.query("ROLLBACK")
    for (const f of movedFiles) await fs.unlink(f).catch(() => undefined)
    throw err
  } finally {
    tx.release()
  }
}

export async function repoIsOperationDossierDocumentLinked(documentId: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM public.operation_dossier_version_documents WHERE document_id = $1::uuid LIMIT 1`,
    [documentId]
  )
  return (res.rowCount ?? 0) > 0
}

export async function repoGetOperationDossierDocumentFileMeta(documentId: string): Promise<{ document_id: string; file_name: string | null; mime_type: string | null } | null> {
  const res = await pool.query<{ document_id: string; file_name: string | null; mime_type: string | null }>(
    `
      SELECT
        document_id::text AS document_id,
        file_name,
        mime_type
      FROM public.operation_dossier_version_documents
      WHERE document_id = $1::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [documentId]
  )
  return res.rows[0] ?? null
}

export async function repoGetDocumentName(documentId: string): Promise<string | null> {
  const res = await pool.query<{ document_name: string }>(`SELECT document_name FROM public.documents_clients WHERE id = $1`, [documentId])
  const name = res.rows[0]?.document_name
  return typeof name === "string" && name.trim() ? name.trim() : null
}

export async function repoFindOperationDossierDocumentFilePath(params: { documentId: string; fileNameHint?: string | null }): Promise<string | null> {
  const baseDir = await ensureDocsDir()
  const safeExt = params.fileNameHint ? safeExtFromName(params.fileNameHint) : ""
  if (safeExt) {
    const candidate = path.join(baseDir, `${params.documentId}${safeExt}`)
    try {
      await fs.stat(candidate)
      return candidate
    } catch {
      // continue
    }
  }

  const entries = await fs.readdir(baseDir).catch(() => [])
  const match = entries.find((e) => e.startsWith(params.documentId))
  if (!match) return null
  const candidate = path.join(baseDir, match)
  try {
    await fs.stat(candidate)
    return candidate
  } catch {
    return null
  }
}

export function buildOperationDossierOperationResponse(input: { dossier: OperationDossierHeader; versions: OperationDossierVersion[] }): OperationDossierOperationResponse {
  const latest = input.versions.length ? input.versions[0] : null
  return { dossier: input.dossier, versions: input.versions, latest }
}

export function parseSlotOverrideMap(args: { body: Record<string, unknown>; prefix: string }): Map<string, SlotOverride> {
  const out = new Map<string, SlotOverride>()
  const re = new RegExp(`^${args.prefix}\\[([A-Za-z0-9_-]+)\\]$`)
  for (const [k, v] of Object.entries(args.body)) {
    const m = re.exec(k)
    if (!m) continue
    const slotKey = m[1]
    const value = typeof v === "string" ? v : v === null || v === undefined ? null : String(v)
    out.set(slotKey, { has: true, value })
  }
  return out
}

export function parseUploadsBySlot(files: UploadedDocument[]): Map<string, UploadedDocument> {
  const out = new Map<string, UploadedDocument>()
  for (const f of files) {
    const m = /^documents\[([A-Za-z0-9_-]+)\]$/.exec(f.fieldname)
    if (!m) continue
    const slotKey = m[1]
    if (out.has(slotKey)) {
      throw new HttpError(400, "DUPLICATE_SLOT_FILE", `Multiple files uploaded for slot ${slotKey}`)
    }
    out.set(slotKey, f)
  }
  return out
}

export function validateSlotKeysForDossierType(args: { dossier_type: OperationDossierType; slotKeys: Iterable<string> }) {
  const allowed = new Set(slotKeysForType(args.dossier_type))
  for (const k of args.slotKeys) {
    if (!allowed.has(k)) {
      throw new HttpError(400, "INVALID_SLOT_KEY", `Slot key not allowed for dossier_type ${args.dossier_type}: ${k}`)
    }
  }
}

export function computeContentDisposition(args: { download: boolean; filename: string }): string {
  const clean = args.filename.replace(/\"/g, "")
  return `${args.download ? "attachment" : "inline"}; filename="${clean}"`
}

export function getDownloadFlag(value: unknown): boolean {
  if (value === true || value === 1) return true
  if (typeof value === "string") {
    const v = value.trim().toLowerCase()
    return v === "true" || v === "1" || v === "yes" || v === "y"
  }
  return false
}

export function pickMimeType(primary: string | null | undefined): string {
  return resolveMimeType(primary)
}
