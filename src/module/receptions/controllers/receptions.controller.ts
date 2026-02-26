import type { Request, RequestHandler, Response } from "express"
import fs from "node:fs/promises"
import path from "node:path"

import { HttpError } from "../../../utils/httpError"
import { emitEntityChanged } from "../../../shared/realtime/realtime.service"
import type { AuditContext } from "../repository/receptions.repository"
import {
  addMeasurementSchema,
  attachDocumentsBodySchema,
  createLineSchema,
  createLotForLineSchema,
  createReceptionSchema,
  docIdParamSchema,
  lineIdParamSchema,
  listReceptionsQuerySchema,
  patchReceptionSchema,
  receptionIdParamSchema,
  stockReceiptSchema,
  decideInspectionSchema,
} from "../validators/receptions.validators"
import {
  addIncomingMeasurementSVC,
  attachReceptionDocumentsSVC,
  createLotForLineSVC,
  createReceptionLineSVC,
  createReceptionSVC,
  createReceptionStockReceiptSVC,
  decideIncomingInspectionSVC,
  downloadReceptionDocumentSVC,
  getReceptionSVC,
  getReceptionsKpisSVC,
  listReceptionsSVC,
  patchReceptionSVC,
  removeReceptionDocumentSVC,
  startIncomingInspectionSVC,
} from "../services/receptions.service"

function buildAuditContext(req: Request): AuditContext {
  const user = req.user
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required")

  const forwardedFor = req.headers["x-forwarded-for"]
  const ipFromHeader = typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() : null
  const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null
  const pageKey = typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null
  const clientSessionId =
    typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"]
        : null

  return {
    user_id: user.id,
    ip: ipFromHeader ?? req.ip ?? null,
    user_agent: ua,
    device_type: null,
    os: null,
    browser: null,
    path: req.originalUrl ?? null,
    page_key: pageKey,
    client_session_id: clientSessionId,
  }
}

function getUserRef(req: Request): { id: number; name: string } {
  const user = req.user
  if (!user || typeof user.id !== "number") throw new HttpError(401, "UNAUTHORIZED", "Authentication required")
  const name = typeof user.username === "string" && user.username.trim() ? user.username.trim() : String(user.id)
  return { id: user.id, name }
}

function emitReceptionChanged(
  req: Request,
  params: { receptionId: string; action: "created" | "updated" | "deleted" | "status_changed" }
) {
  const receptionId = params.receptionId
  emitEntityChanged({
    entityType: "RECEPTION",
    entityId: receptionId,
    action: params.action,
    module: "receptions",
    at: new Date().toISOString(),
    by: getUserRef(req),
    invalidateKeys: ["receptions:list", "receptions:kpis", `receptions:detail:${receptionId}`],
  })
}

function isMulterFile(value: unknown): value is Express.Multer.File {
  if (typeof value !== "object" || value === null) return false
  const v = value as { path?: unknown; originalname?: unknown; mimetype?: unknown; size?: unknown }
  return typeof v.path === "string" && typeof v.originalname === "string" && typeof v.mimetype === "string" && typeof v.size === "number"
}

function getMulterFiles(req: Request): Express.Multer.File[] {
  const files = (req as Request & { files?: unknown }).files
  if (!Array.isArray(files)) return []
  return files.filter(isMulterFile)
}

async function sendDocumentFile(
  req: Request,
  res: Response,
  doc: { storage_path: string; mime_type: string; original_name: string }
) {
  const baseDir = path.resolve(path.posix.join("uploads", "docs", "receptions"))
  const absPath = path.resolve(doc.storage_path)
  const basePrefix = baseDir.endsWith(path.sep) ? baseDir : `${baseDir}${path.sep}`
  if (!absPath.startsWith(basePrefix)) {
    throw new HttpError(400, "INVALID_STORAGE_PATH", "Invalid document storage path")
  }

  await fs.access(absPath)
  res.setHeader("Content-Type", doc.mime_type)

  const rawDownload = (req.query as { download?: unknown } | undefined)?.download
  const download = rawDownload === true || rawDownload === "true" || rawDownload === "1" || rawDownload === 1
  res.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="${encodeURIComponent(doc.original_name)}"`
  )
  res.sendFile(absPath)
}

export const listReceptions: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listReceptionsQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" })
      return
    }
    const out = await listReceptionsSVC(parsed.data)
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const getReceptionsKpis: RequestHandler = async (_req, res, next) => {
  try {
    const out = await getReceptionsKpisSVC()
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const createReception: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = createReceptionSchema.parse({ body: req.body }).body
    const out = await createReceptionSVC(body, audit)

    emitReceptionChanged(req, { receptionId: out.id, action: "created" })
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const getReception: RequestHandler = async (req, res, next) => {
  try {
    const { id } = receptionIdParamSchema.parse({ params: req.params }).params
    const out = await getReceptionSVC(id)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const patchReception: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id } = receptionIdParamSchema.parse({ params: req.params }).params
    const patch = patchReceptionSchema.parse({ body: req.body }).body
    const out = await patchReceptionSVC(id, patch, audit)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }

    emitReceptionChanged(req, { receptionId: id, action: "updated" })
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const createReceptionLine: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id } = receptionIdParamSchema.parse({ params: req.params }).params
    const body = createLineSchema.parse({ body: req.body }).body
    const out = await createReceptionLineSVC(id, body, audit)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }

    emitReceptionChanged(req, { receptionId: id, action: "updated" })
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const createLotForReceptionLine: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id, lineId } = lineIdParamSchema.parse({ params: req.params }).params
    const body = createLotForLineSchema.parse({ body: req.body }).body
    const out = await createLotForLineSVC(id, lineId, body, audit)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }

    emitReceptionChanged(req, { receptionId: id, action: "updated" })
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const attachReceptionDocuments: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id } = receptionIdParamSchema.parse({ params: req.params }).params
    const body = attachDocumentsBodySchema.parse(req.body)
    const files = getMulterFiles(req)
    const out = await attachReceptionDocumentsSVC(id, body, files, audit)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }

    emitReceptionChanged(req, { receptionId: id, action: "updated" })
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const removeReceptionDocument: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id, docId } = docIdParamSchema.parse({ params: req.params }).params
    const ok = await removeReceptionDocumentSVC(id, docId, audit)
    if (ok === null || ok === false) {
      res.status(404).json({ error: "Not found" })
      return
    }

    emitReceptionChanged(req, { receptionId: id, action: "updated" })
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}

export const downloadReceptionDocument: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id, docId } = docIdParamSchema.parse({ params: req.params }).params
    const doc = await downloadReceptionDocumentSVC(id, docId, audit)
    if (!doc) {
      res.status(404).json({ error: "Not found" })
      return
    }
    await sendDocumentFile(req, res, doc)
  } catch (err) {
    next(err)
  }
}

export const startIncomingInspection: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id, lineId } = lineIdParamSchema.parse({ params: req.params }).params
    const out = await startIncomingInspectionSVC(id, lineId, audit)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }

    emitReceptionChanged(req, { receptionId: id, action: "updated" })
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}

export const addIncomingMeasurement: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id, lineId } = lineIdParamSchema.parse({ params: req.params }).params
    const body = addMeasurementSchema.parse({ body: req.body }).body
    const out = await addIncomingMeasurementSVC(id, lineId, body, audit)

    emitReceptionChanged(req, { receptionId: id, action: "updated" })
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const decideIncomingInspection: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id, lineId } = lineIdParamSchema.parse({ params: req.params }).params
    const body = decideInspectionSchema.parse({ body: req.body }).body
    const out = await decideIncomingInspectionSVC(id, lineId, body, audit)

    emitReceptionChanged(req, { receptionId: id, action: "status_changed" })
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}

export const createReceptionStockReceipt: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id, lineId } = lineIdParamSchema.parse({ params: req.params }).params
    const body = stockReceiptSchema.parse({ body: req.body }).body
    const out = await createReceptionStockReceiptSVC(id, lineId, body, audit)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }

    emitReceptionChanged(req, { receptionId: id, action: "updated" })
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}
