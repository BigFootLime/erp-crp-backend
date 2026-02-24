import type { RequestHandler } from "express"

import { HttpError } from "../../../utils/httpError"
import { packGenerateBodySchema, packPreviewParamsSchema, packRevokeParamsSchema } from "../validators/pack.validators"
import { repoFindDocumentFilePath, repoGetDocumentName, repoIsLivraisonDocumentLinked } from "../repository/livraisons.repository"
import { svcGenerateLivraisonPack, svcGetLivraisonPackPreview, svcRevokeLivraisonPackVersion } from "../services/pack.service"

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

export const getLivraisonPackPreview: RequestHandler = async (req, res, next) => {
  try {
    getUserId(req)
    const { id } = packPreviewParamsSchema.parse(req.params)
    const out = await svcGetLivraisonPackPreview(id)
    res.json(out)
  } catch (e) {
    next(e)
  }
}

export const generateLivraisonPack: RequestHandler = async (req, res, next) => {
  try {
    const actorUserId = getUserId(req)
    const { id } = packPreviewParamsSchema.parse(req.params)
    const body = packGenerateBodySchema.parse(req.body)
    const out = await svcGenerateLivraisonPack({ bonLivraisonId: id, actorUserId, body })
    res.status(201).json(out)
  } catch (e) {
    next(e)
  }
}

export const downloadLivraisonPackDocument: RequestHandler = async (req, res, next) => {
  try {
    getUserId(req)
    const { id } = packPreviewParamsSchema.parse(req.params)
    const documentId = req.params.documentId
    if (!documentId || !/^[0-9a-fA-F-]{36}$/.test(documentId)) {
      res.status(400).json({ error: "Invalid documentId" })
      return
    }

    const linked = await repoIsLivraisonDocumentLinked(id, documentId)
    if (!linked) {
      res.status(404).json({ error: "Not found" })
      return
    }

    const download = coerceBool((req.query as { download?: unknown } | undefined)?.download)
    const filePath = await repoFindDocumentFilePath(documentId)
    if (!filePath) {
      res.status(404).json({ error: "File not found" })
      return
    }
    const name = (await repoGetDocumentName(documentId)) ?? `document-${id}.pdf`
    const disposition = download ? "attachment" : "inline"
    res.setHeader("Content-Type", "application/pdf")
    res.setHeader("Content-Disposition", `${disposition}; filename=\"${name.replace(/\"/g, "")}\"`)
    res.sendFile(filePath)
  } catch (e) {
    next(e)
  }
}

export const revokeLivraisonPackVersion: RequestHandler = async (req, res, next) => {
  try {
    const actorUserId = getUserId(req)
    const { id, versionId } = packRevokeParamsSchema.parse(req.params)
    const out = await svcRevokeLivraisonPackVersion({ bonLivraisonId: id, versionId, actorUserId })
    res.status(200).json(out)
  } catch (e) {
    next(e)
  }
}
