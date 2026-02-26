import type { RequestHandler } from "express"

import { HttpError } from "../../../utils/httpError"

import { svcGenerateAsbuiltPack, svcGetAsbuiltPreview, svcResolveAsbuiltDocument } from "../services/asbuilt.service"
import { asbuiltDownloadParamsSchema, asbuiltGenerateBodySchema, asbuiltLotParamsSchema } from "../validators/asbuilt.validators"

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

export const getAsbuiltPreview: RequestHandler = async (req, res, next) => {
  try {
    getUserId(req)
    const { lotId } = asbuiltLotParamsSchema.parse(req.params)
    const out = await svcGetAsbuiltPreview(lotId)
    res.json(out)
  } catch (e) {
    next(e)
  }
}

export const generateAsbuiltPack: RequestHandler = async (req, res, next) => {
  try {
    const actorUserId = getUserId(req)
    const { lotId } = asbuiltLotParamsSchema.parse(req.params)
    const body = asbuiltGenerateBodySchema.parse(req.body)
    const out = await svcGenerateAsbuiltPack({ lotId, actorUserId, body })
    res.status(201).json(out)
  } catch (e) {
    next(e)
  }
}

export const downloadAsbuiltDocument: RequestHandler = async (req, res, next) => {
  try {
    getUserId(req)
    const { lotId, documentId } = asbuiltDownloadParamsSchema.parse(req.params)
    const download = coerceBool((req.query as { download?: unknown } | undefined)?.download)

    const { filePath, name } = await svcResolveAsbuiltDocument({ lotId, documentId })

    const disposition = download ? "attachment" : "inline"
    res.setHeader("Content-Type", "application/pdf")
    res.setHeader("Content-Disposition", `${disposition}; filename=\"${name.replace(/\"/g, "")}\"`)
    res.sendFile(filePath)
  } catch (e) {
    next(e)
  }
}
