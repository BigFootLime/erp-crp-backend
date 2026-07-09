// src/module/gammes/controllers/gammes.controller.ts
// GPAO B2.2 — HTTP handlers gammes + opérations de gamme.
import type { Request, RequestHandler } from "express"
import { HttpError } from "../../../utils/httpError"
import type { AuditContext } from "../../pieces-techniques/repository/pieces-techniques.repository"
import {
  addGammeOperationSchema,
  createGammeSchema,
  reorderOperationsSchema,
  updateGammeSchema,
} from "../validators/gammes.validators"
import {
  addGammeOperationSVC,
  createGammeSVC,
  listGammeOperationsSVC,
  listGammesByVersionSVC,
  reorderGammeOperationsSVC,
  updateGammeSVC,
} from "../services/gammes.service"

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

export const listGammesByVersion: RequestHandler = async (req, res, next) => {
  try {
    const items = await listGammesByVersionSVC(req.params.versionId)
    res.json(items)
  } catch (err) {
    next(err)
  }
}

export const createGamme: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = createGammeSchema.parse({ body: req.body }).body
    const out = await createGammeSVC(req.params.versionId, body, audit)
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const updateGamme: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = updateGammeSchema.parse({ body: req.body }).body
    const out = await updateGammeSVC(req.params.gammeId, body, audit)
    if (!out) throw new HttpError(404, "NOT_FOUND", "Gamme introuvable")
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const listGammeOperations: RequestHandler = async (req, res, next) => {
  try {
    const items = await listGammeOperationsSVC(req.params.gammeId)
    res.json(items)
  } catch (err) {
    next(err)
  }
}

export const addGammeOperation: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = addGammeOperationSchema.parse({ body: req.body }).body
    const out = await addGammeOperationSVC(req.params.gammeId, body, audit)
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const reorderGammeOperations: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = reorderOperationsSchema.parse({ body: req.body }).body
    const out = await reorderGammeOperationsSVC(req.params.gammeId, body.order, audit)
    res.json(out)
  } catch (err) {
    next(err)
  }
}
