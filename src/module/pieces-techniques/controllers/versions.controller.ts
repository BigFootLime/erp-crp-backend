// src/module/pieces-techniques/controllers/versions.controller.ts
// GPAO B2.1 — HTTP handlers des versions/indices.
import type { Request, RequestHandler } from "express"
import { HttpError } from "../../../utils/httpError"
import type { AuditContext } from "../repository/pieces-techniques.repository"
import {
  createNextVersionSchema,
  createVersionSchema,
  updateVersionSchema,
  publishVersionSchema,
  versionStatusSchema,
} from "../validators/versions.validators"
import {
  createNextVersionSVC,
  createVersionSVC,
  listVersionsSVC,
  updateVersionSVC,
  updateVersionStatusSVC,
  publishVersionSVC,
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

function routeParam(req: Request, name: string): string {
  const value = req.params[name]
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "INVALID_ROUTE_PARAM", `Paramètre de route invalide : ${name}`)
  }
  return value
}

export const listVersions: RequestHandler = async (req, res, next) => {
  try {
    const items = await listVersionsSVC(routeParam(req, "id"))
    res.json(items)
  } catch (err) {
    next(err)
  }
}

export const createVersion: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = createVersionSchema.parse({ body: req.body }).body
    const out = await createVersionSVC(routeParam(req, "id"), body, audit)
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const updateVersion: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = updateVersionSchema.parse({ body: req.body }).body
    const out = await updateVersionSVC(
      routeParam(req, "id"),
      routeParam(req, "versionId"),
      body,
      audit
    )
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
    const out = await updateVersionStatusSVC(
      routeParam(req, "id"),
      routeParam(req, "versionId"),
      body,
      audit
    )
    if (!out) throw new HttpError(404, "NOT_FOUND", "Version introuvable")
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const publishVersion: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = publishVersionSchema.parse({ body: req.body }).body
    const out = await publishVersionSVC(
      routeParam(req, "id"),
      routeParam(req, "versionId"),
      body,
      audit
    )
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
    const out = await createNextVersionSVC(
      routeParam(req, "id"),
      routeParam(req, "versionId"),
      body,
      audit
    )
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}
