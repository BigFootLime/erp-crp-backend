// src/module/pieces-techniques/controllers/versions.controller.ts
// GPAO B2.1 — HTTP handlers des versions/indices.
import type { Request, RequestHandler } from "express"
import { HttpError } from "../../../utils/httpError"
import type { AuditContext } from "../repository/pieces-techniques.repository"
import {
  createNextVersionSchema,
  createVersionSchema,
  updateVersionSchema,
  versionStatusSchema,
} from "../validators/versions.validators"
import {
  createNextVersionSVC,
  createVersionSVC,
  listVersionsSVC,
  updateVersionSVC,
  updateVersionStatusSVC,
} from "../services/versions.service"

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

export const listVersions: RequestHandler = async (req, res, next) => {
  try {
    const items = await listVersionsSVC(req.params.id)
    res.json(items)
  } catch (err) {
    next(err)
  }
}

export const createVersion: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = createVersionSchema.parse({ body: req.body }).body
    const out = await createVersionSVC(req.params.id, body, audit)
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const updateVersion: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = updateVersionSchema.parse({ body: req.body }).body
    const out = await updateVersionSVC(req.params.id, req.params.versionId, body, audit)
    if (!out) throw new HttpError(404, "NOT_FOUND", "Version introuvable")
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const updateVersionStatus: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = versionStatusSchema.parse({ body: req.body }).body
    const out = await updateVersionStatusSVC(req.params.id, req.params.versionId, body, audit)
    if (!out) throw new HttpError(404, "NOT_FOUND", "Version introuvable")
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const createNextVersion: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = createNextVersionSchema.parse({ body: req.body }).body
    const out = await createNextVersionSVC(req.params.id, req.params.versionId, body, audit)
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}
