import type { Request, RequestHandler, Response } from "express"
import fs from "node:fs/promises"
import path from "node:path"

import { HttpError } from "../../../utils/httpError"
import type { AuditContext } from "../repository/fournisseurs.repository"
import {
  attachDocumentsBodySchema,
  catalogueIdParamSchema,
  contactIdParamSchema,
  createCatalogueSchema,
  createContactSchema,
  createFournisseurSchema,
  docIdParamSchema,
  fournisseurIdParamSchema,
  listCatalogueQuerySchema,
  listFournisseursQuerySchema,
  updateCatalogueSchema,
  updateContactSchema,
  updateFournisseurSchema,
} from "../validators/fournisseurs.validators"
import {
  attachFournisseurDocumentsSVC,
  createFournisseurCatalogueItemSVC,
  createFournisseurContactSVC,
  createFournisseurSVC,
  deactivateFournisseurSVC,
  deleteFournisseurCatalogueItemSVC,
  deleteFournisseurContactSVC,
  downloadFournisseurDocumentSVC,
  getFournisseurSVC,
  listFournisseurCatalogueSVC,
  listFournisseurContactsSVC,
  listFournisseurDocumentsSVC,
  listFournisseursSVC,
  removeFournisseurDocumentSVC,
  updateFournisseurCatalogueItemSVC,
  updateFournisseurContactSVC,
  updateFournisseurSVC,
} from "../services/fournisseurs.service"

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
  const baseDir = path.resolve(path.posix.join("uploads", "docs", "fournisseurs"))
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

export const listFournisseurs: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listFournisseursQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" })
      return
    }
    const out = await listFournisseursSVC(parsed.data)
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const createFournisseur: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = createFournisseurSchema.parse({ body: req.body }).body
    const out = await createFournisseurSVC(body, audit)
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const getFournisseur: RequestHandler = async (req, res, next) => {
  try {
    const { id } = fournisseurIdParamSchema.parse({ params: req.params }).params
    const out = await getFournisseurSVC(id)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const updateFournisseur: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id } = fournisseurIdParamSchema.parse({ params: req.params }).params
    const body = updateFournisseurSchema.parse({ body: req.body }).body
    const out = await updateFournisseurSVC(id, body, audit)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const deactivateFournisseur: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id } = fournisseurIdParamSchema.parse({ params: req.params }).params
    const ok = await deactivateFournisseurSVC(id, audit)
    if (!ok) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}

export const listFournisseurContacts: RequestHandler = async (req, res, next) => {
  try {
    const { id } = fournisseurIdParamSchema.parse({ params: req.params }).params
    const out = await listFournisseurContactsSVC(id)
    if (out === null) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const createFournisseurContact: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id } = fournisseurIdParamSchema.parse({ params: req.params }).params
    const body = createContactSchema.parse({ body: req.body }).body
    const out = await createFournisseurContactSVC(id, body, audit)
    if (out === null) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const updateFournisseurContact: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id, contactId } = contactIdParamSchema.parse({ params: req.params }).params
    const body = updateContactSchema.parse({ body: req.body }).body
    const out = await updateFournisseurContactSVC(id, contactId, body, audit)
    if (out === null || out === false) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const deleteFournisseurContact: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id, contactId } = contactIdParamSchema.parse({ params: req.params }).params
    const out = await deleteFournisseurContactSVC(id, contactId, audit)
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

export const listFournisseurCatalogue: RequestHandler = async (req, res, next) => {
  try {
    const { id } = fournisseurIdParamSchema.parse({ params: req.params }).params
    const parsed = listCatalogueQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" })
      return
    }
    const out = await listFournisseurCatalogueSVC(id, parsed.data)
    if (out === null) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const createFournisseurCatalogueItem: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id } = fournisseurIdParamSchema.parse({ params: req.params }).params
    const body = createCatalogueSchema.parse({ body: req.body }).body
    const out = await createFournisseurCatalogueItemSVC(id, body, audit)
    if (out === null) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const updateFournisseurCatalogueItem: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id, catalogueId } = catalogueIdParamSchema.parse({ params: req.params }).params
    const body = updateCatalogueSchema.parse({ body: req.body }).body
    const out = await updateFournisseurCatalogueItemSVC(id, catalogueId, body, audit)
    if (out === null || out === false) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const deleteFournisseurCatalogueItem: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id, catalogueId } = catalogueIdParamSchema.parse({ params: req.params }).params
    const out = await deleteFournisseurCatalogueItemSVC(id, catalogueId, audit)
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

export const listFournisseurDocuments: RequestHandler = async (req, res, next) => {
  try {
    const { id } = fournisseurIdParamSchema.parse({ params: req.params }).params
    const out = await listFournisseurDocumentsSVC(id)
    if (out === null) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const attachFournisseurDocuments: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id } = fournisseurIdParamSchema.parse({ params: req.params }).params
    const body = attachDocumentsBodySchema.parse(req.body)
    const files = getMulterFiles(req)
    if (!files.length) {
      res.status(400).json({ error: "No documents uploaded" })
      return
    }
    const out = await attachFournisseurDocumentsSVC(id, body, files, audit)
    if (out === null) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const removeFournisseurDocument: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id, docId } = docIdParamSchema.parse({ params: req.params }).params
    const out = await removeFournisseurDocumentSVC(id, docId, audit)
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

export const downloadFournisseurDocument: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { id, docId } = docIdParamSchema.parse({ params: req.params }).params
    const doc = await downloadFournisseurDocumentSVC(id, docId, audit)
    if (!doc) {
      res.status(404).json({ error: "Not found" })
      return
    }
    await sendDocumentFile(req, res, doc)
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      next(new HttpError(404, "FILE_NOT_FOUND", "File not found"))
      return
    }
    next(err)
  }
}
