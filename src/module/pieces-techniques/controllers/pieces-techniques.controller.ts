// src/module/pieces-techniques/controllers/pieces-techniques.controller.ts
import type { Request, RequestHandler } from "express"
import fs from "node:fs/promises"
import path from "node:path"
import { HttpError } from "../../../utils/httpError"
import {
  achatIdParamSchema,
  addAchatSchema,
  addBomLineSchema,
  linkAffaireSchema,
  addOperationSchema,
  affaireIdParamSchema,
  affaireOnlyParamSchema,
  bomLineIdParamSchema,
  createPieceTechniqueSchema,
  documentIdParamSchema,
  getPieceTechniqueQuerySchema,
  idParamSchema,
  listPiecesTechniquesQuerySchema,
  operationIdParamSchema,
  pieceTechniqueStatusSchema,
  reorderSchema,
  updateAchatSchema,
  updateBomLineSchema,
  updateOperationSchema,
  updatePieceTechniqueSchema,
  type CreatePieceTechniqueBodyDTO,
  type AddAchatBodyDTO,
  type AddBomLineBodyDTO,
  type LinkAffaireBodyDTO,
  type AddOperationBodyDTO,
  type PieceTechniqueStatusBodyDTO,
  type ReorderBodyDTO,
  type UpdateAchatBodyDTO,
  type UpdateBomLineBodyDTO,
  type UpdateOperationBodyDTO,
  type UpdatePieceTechniqueBodyDTO,
} from "../validators/pieces-techniques.validators"
import {
  addAchatSVC,
  addBomLineSVC,
  addOperationSVC,
  deleteAchatSVC,
  deleteBomLineSVC,
  deleteOperationSVC,
  deletePieceTechniqueSVC,
  duplicatePieceTechniqueSVC,
  getPieceTechniqueSVC,
  listPieceTechniquesSVC,
  reorderAchatsSVC,
  reorderBomSVC,
  reorderOperationsSVC,
  updateAchatSVC,
  updateBomLineSVC,
  updateOperationSVC,
  updatePieceTechniqueSVC,
  updatePieceTechniqueStatusSVC,
  createPieceTechniqueSVC,
  attachPieceTechniqueDocumentsSVC,
  downloadPieceTechniqueDocumentSVC,
  listPieceTechniqueDocumentsSVC,
  linkPieceTechniqueAffaireSVC,
  listAffairePieceTechniquesSVC,
  listPieceTechniqueAffairesSVC,
  removePieceTechniqueDocumentSVC,
  unlinkPieceTechniqueAffaireSVC,
} from "../services/pieces-techniques.service"

import type { AuditContext } from "../repository/pieces-techniques.repository"

function parseIncludeSet(req: Request) {
  const parsed = getPieceTechniqueQuerySchema.safeParse(req.query)
  const includeStr = parsed.success ? parsed.data.include : ""
  return new Set(
    includeStr
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  )
}

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

export const createPieceTechnique: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body: CreatePieceTechniqueBodyDTO = createPieceTechniqueSchema.parse({ body: req.body }).body
    const out = await createPieceTechniqueSVC(body, audit)
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const listPieceTechniques: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listPiecesTechniquesQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" })
      return
    }

    const out = await listPieceTechniquesSVC(parsed.data)
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const getPieceTechnique: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const includes = parseIncludeSet(req)
    const out = await getPieceTechniqueSVC(id, includes)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const updatePieceTechnique: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const audit = buildAuditContext(req)
    const body: UpdatePieceTechniqueBodyDTO = updatePieceTechniqueSchema.parse({ body: req.body }).body
    const out = await updatePieceTechniqueSVC(id, body, audit)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}

export const deletePieceTechnique: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const audit = buildAuditContext(req)
    const ok = await deletePieceTechniqueSVC(id, audit)
    if (!ok) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}

export const duplicatePieceTechnique: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const userId = req.user?.id ?? null
    const out = await duplicatePieceTechniqueSVC(id, userId)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const updatePieceTechniqueStatus: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const audit = buildAuditContext(req)
    const body: PieceTechniqueStatusBodyDTO = pieceTechniqueStatusSchema.parse({ body: req.body }).body
    const out = await updatePieceTechniqueStatusSVC(id, body, audit)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
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

export const listPieceTechniqueDocuments: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const out = await listPieceTechniqueDocumentsSVC(id)
    if (out === null) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const attachPieceTechniqueDocuments: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const audit = buildAuditContext(req)
    const files = getMulterFiles(req)
    const out = await attachPieceTechniqueDocumentsSVC(id, files, audit)
    if (out === null) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const removePieceTechniqueDocument: RequestHandler = async (req, res, next) => {
  try {
    const { id, docId } = documentIdParamSchema.parse({ params: req.params }).params
    const audit = buildAuditContext(req)
    const out = await removePieceTechniqueDocumentSVC(id, docId, audit)
    if (out === null) {
      res.status(404).json({ error: "Not found" })
      return
    }
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}

export const downloadPieceTechniqueDocument: RequestHandler = async (req, res, next) => {
  try {
    const { id, docId } = documentIdParamSchema.parse({ params: req.params }).params
    const audit = buildAuditContext(req)
    const doc = await downloadPieceTechniqueDocumentSVC(id, docId, audit)
    if (!doc) {
      res.status(404).json({ error: "Not found" })
      return
    }

    const baseDir = path.resolve("uploads/docs/pieces-techniques")
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
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      next(new HttpError(404, "FILE_NOT_FOUND", "File not found"))
      return
    }
    next(err)
  }
}

export const listPieceTechniqueAffaires: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const out = await listPieceTechniqueAffairesSVC(id)
    if (out === null) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const listAffairePieceTechniques: RequestHandler = async (req, res, next) => {
  try {
    const { affaireId } = affaireOnlyParamSchema.parse({ params: req.params }).params
    const out = await listAffairePieceTechniquesSVC(affaireId)
    if (out === null) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const linkPieceTechniqueAffaire: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const audit = buildAuditContext(req)
    const body: LinkAffaireBodyDTO = linkAffaireSchema.parse({ body: req.body }).body
    const out = await linkPieceTechniqueAffaireSVC(id, body.affaire_id, body.role, audit)
    if (out === null) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}

export const unlinkPieceTechniqueAffaire: RequestHandler = async (req, res, next) => {
  try {
    const { id, affaireId } = affaireIdParamSchema.parse({ params: req.params }).params
    const audit = buildAuditContext(req)
    const out = await unlinkPieceTechniqueAffaireSVC(id, affaireId, audit)
    if (out === null) {
      res.status(404).json({ error: "Not found" })
      return
    }
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}

export const addBomLine: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const body = req.body as AddBomLineBodyDTO
    const out = await addBomLineSVC(id, body)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const updateBomLine: RequestHandler = async (req, res, next) => {
  try {
    const { id, lineId } = bomLineIdParamSchema.parse({ params: req.params }).params
    const body = req.body as UpdateBomLineBodyDTO
    const out = await updateBomLineSVC(id, lineId, body)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}

export const deleteBomLine: RequestHandler = async (req, res, next) => {
  try {
    const { id, lineId } = bomLineIdParamSchema.parse({ params: req.params }).params
    const ok = await deleteBomLineSVC(id, lineId)
    if (!ok) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}

export const reorderBom: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const body = req.body as ReorderBodyDTO
    const out = await reorderBomSVC(id, body.order)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}

export const addOperation: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const body = req.body as AddOperationBodyDTO
    const out = await addOperationSVC(id, body)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const updateOperation: RequestHandler = async (req, res, next) => {
  try {
    const { id, opId } = operationIdParamSchema.parse({ params: req.params }).params
    const body = req.body as UpdateOperationBodyDTO
    const out = await updateOperationSVC(id, opId, body)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}

export const deleteOperation: RequestHandler = async (req, res, next) => {
  try {
    const { id, opId } = operationIdParamSchema.parse({ params: req.params }).params
    const ok = await deleteOperationSVC(id, opId)
    if (!ok) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}

export const reorderOperations: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const body = req.body as ReorderBodyDTO
    const out = await reorderOperationsSVC(id, body.order)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}

export const addAchat: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const body = req.body as AddAchatBodyDTO
    const out = await addAchatSVC(id, body)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const updateAchat: RequestHandler = async (req, res, next) => {
  try {
    const { id, achatId } = achatIdParamSchema.parse({ params: req.params }).params
    const body = req.body as UpdateAchatBodyDTO
    const out = await updateAchatSVC(id, achatId, body)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}

export const deleteAchat: RequestHandler = async (req, res, next) => {
  try {
    const { id, achatId } = achatIdParamSchema.parse({ params: req.params }).params
    const ok = await deleteAchatSVC(id, achatId)
    if (!ok) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}

export const reorderAchats: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const body = req.body as ReorderBodyDTO
    const out = await reorderAchatsSVC(id, body.order)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}
