import type { RequestHandler } from "express"
import fs from "node:fs/promises"

import { HttpError } from "../../../utils/httpError"
import {
  createLivraisonBodySchema,
  createLivraisonLineBodySchema,
  fromCommandeParamsSchema,
  listLivraisonsQuerySchema,
  livraisonIdParamsSchema,
  livraisonLineIdParamsSchema,
  livraisonStatusBodySchema,
  updateLivraisonBodySchema,
  updateLivraisonLineBodySchema,
} from "../validators/livraisons.validators"
import * as service from "../services/livraisons.service"
import * as pdfService from "../services/pdf.service"
import { repoFindDocumentFilePath, repoGetDocumentName, repoIsLivraisonDocumentLinked } from "../repository/livraisons.repository"

function coerceBool(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value === 1
  if (typeof value === "string") {
    const v = value.trim().toLowerCase()
    return v === "true" || v === "1" || v === "yes" || v === "y"
  }
  return false
}

function getUserId(req: Express.Request): number {
  const userId = typeof req.user?.id === "number" ? req.user.id : null
  if (!userId) throw new HttpError(401, "UNAUTHORIZED", "Authentication required")
  return userId
}

export const listLivraisons: RequestHandler = async (req, res, next) => {
  try {
    getUserId(req)
    const query = listLivraisonsQuerySchema.parse(req.query)
    const out = await service.svcListLivraisons(query)
    res.json(out)
  } catch (e) {
    next(e)
  }
}

export const getLivraison: RequestHandler = async (req, res, next) => {
  try {
    getUserId(req)
    const { id } = livraisonIdParamsSchema.parse(req.params)
    const out = await service.svcGetLivraison(id)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(out)
  } catch (e) {
    next(e)
  }
}

export const createLivraison: RequestHandler = async (req, res, next) => {
  try {
    const userId = getUserId(req)
    const dto = createLivraisonBodySchema.parse(req.body)
    const out = await service.svcCreateLivraison(dto, userId)
    res.status(201).json(out)
  } catch (e) {
    next(e)
  }
}

export const createLivraisonFromCommande: RequestHandler = async (req, res, next) => {
  try {
    const userId = getUserId(req)
    const { commandeId } = fromCommandeParamsSchema.parse(req.params)
    const out = await service.svcCreateLivraisonFromCommande(commandeId, userId)
    res.status(201).json(out)
  } catch (e) {
    next(e)
  }
}

export const updateLivraison: RequestHandler = async (req, res, next) => {
  try {
    const userId = getUserId(req)
    const { id } = livraisonIdParamsSchema.parse(req.params)
    const dto = updateLivraisonBodySchema.parse(req.body)
    if (Object.keys(dto).length === 0) {
      res.status(400).json({ error: "No fields to update" })
      return
    }
    const out = await service.svcUpdateLivraisonHeader(id, dto, userId)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (e) {
    next(e)
  }
}

export const addLivraisonLine: RequestHandler = async (req, res, next) => {
  try {
    const userId = getUserId(req)
    const { id } = livraisonIdParamsSchema.parse(req.params)
    const dto = createLivraisonLineBodySchema.parse(req.body)
    const out = await service.svcAddLivraisonLine(id, dto, userId)
    res.status(201).json(out)
  } catch (e) {
    next(e)
  }
}

export const updateLivraisonLine: RequestHandler = async (req, res, next) => {
  try {
    const userId = getUserId(req)
    const { id, lineId } = livraisonLineIdParamsSchema.parse(req.params)
    const dto = updateLivraisonLineBodySchema.parse(req.body)
    if (Object.keys(dto).length === 0) {
      res.status(400).json({ error: "No fields to update" })
      return
    }
    const out = await service.svcUpdateLivraisonLine(id, lineId, dto, userId)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (e) {
    next(e)
  }
}

export const deleteLivraisonLine: RequestHandler = async (req, res, next) => {
  try {
    const userId = getUserId(req)
    const { id, lineId } = livraisonLineIdParamsSchema.parse(req.params)
    const ok = await service.svcDeleteLivraisonLine(id, lineId, userId)
    if (!ok) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (e) {
    next(e)
  }
}

export const updateLivraisonStatus: RequestHandler = async (req, res, next) => {
  try {
    const userId = getUserId(req)
    const { id } = livraisonIdParamsSchema.parse(req.params)
    const body = livraisonStatusBodySchema.parse(req.body)
    const out = await service.svcUpdateLivraisonStatus(id, body, userId)
    res.status(200).json(out)
  } catch (e) {
    next(e)
  }
}

export const uploadLivraisonDocuments: RequestHandler = async (req, res, next) => {
  try {
    const userId = getUserId(req)
    const { id } = livraisonIdParamsSchema.parse(req.params)

    const files = (req.files ?? []) as Express.Multer.File[]
    if (!files.length) {
      res.status(400).json({ error: "No documents uploaded" })
      return
    }

    const body = req.body
    const type =
      typeof body === "object" &&
      body !== null &&
      "type" in body &&
      typeof (body as Record<string, unknown>).type === "string"
        ? String((body as Record<string, unknown>).type)
        : null
    const out = await service.svcAttachLivraisonDocuments({
      bonLivraisonId: id,
      documents: files.map((f) => ({ originalname: f.originalname, path: f.path, mimetype: f.mimetype })),
      type,
      userId,
    })
    res.status(201).json({ documents: out })
  } catch (e) {
    next(e)
  }
}

export const deleteLivraisonDocument: RequestHandler = async (req, res, next) => {
  try {
    const userId = getUserId(req)
    const { id } = livraisonIdParamsSchema.parse(req.params)
    const docId = req.params.docId
    if (!docId || !/^[0-9a-fA-F-]{36}$/.test(docId)) {
      res.status(400).json({ error: "Invalid docId" })
      return
    }

    const ok = await service.svcRemoveLivraisonDocument({ bonLivraisonId: id, documentId: docId, userId })
    if (!ok) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (e) {
    next(e)
  }
}

export const getLivraisonDocumentFile: RequestHandler = async (req, res, next) => {
  try {
    getUserId(req)
    const { id } = livraisonIdParamsSchema.parse(req.params)
    const docId = req.params.docId
    if (!docId || !/^[0-9a-fA-F-]{36}$/.test(docId)) {
      res.status(400).json({ error: "Invalid docId" })
      return
    }

    const linked = await repoIsLivraisonDocumentLinked(id, docId)
    if (!linked) {
      res.status(404).json({ error: "Not found" })
      return
    }

    const filePath = await repoFindDocumentFilePath(docId)
    if (!filePath) {
      res.status(404).json({ error: "File not found" })
      return
    }
    const name = (await repoGetDocumentName(docId)) ?? `document-${id}`
    res.setHeader("Content-Disposition", `inline; filename=\"${name.replace(/\"/g, "")}\"`)
    res.sendFile(filePath)
  } catch (e) {
    next(e)
  }
}

export const generateLivraisonPdf: RequestHandler = async (req, res, next) => {
  try {
    const userId = getUserId(req)
    const { id } = livraisonIdParamsSchema.parse(req.params)
    const out = await pdfService.svcGenerateLivraisonPdf(id, userId)
    res.status(201).json(out)
  } catch (e) {
    next(e)
  }
}

export const getLivraisonPdf: RequestHandler = async (req, res, next) => {
  try {
    const userId = getUserId(req)
    const { id } = livraisonIdParamsSchema.parse(req.params)
    const download = coerceBool((req.query as { download?: unknown } | undefined)?.download)

    let latest = await pdfService.svcGetLatestLivraisonPdfDocument(id)
    if (!latest) {
      const created = await pdfService.svcGenerateLivraisonPdf(id, userId)
      latest = { document_id: created.document_id, version: created.version }
    }

    let filePath = await pdfService.svcGetPdfFilePath(latest.document_id)
    try {
      await fs.stat(filePath)
    } catch {
      const regenerated = await pdfService.svcGenerateLivraisonPdf(id, userId)
      latest = { document_id: regenerated.document_id, version: regenerated.version }
      filePath = await pdfService.svcGetPdfFilePath(latest.document_id)
    }

    const docName = (await pdfService.svcGetDocumentName(latest.document_id)) ?? `bon-livraison-${id}.pdf`
    const disposition = download ? "attachment" : "inline"
    res.setHeader("Content-Type", "application/pdf")
    res.setHeader("Content-Disposition", `${disposition}; filename=\"${docName.replace(/\"/g, "")}\"`)
    res.sendFile(filePath)
  } catch (e) {
    next(e)
  }
}
