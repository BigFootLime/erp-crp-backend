// src/module/gammes/controllers/gammes.controller.ts
// GPAO B2.2 — HTTP handlers gammes + opérations de gamme.
import type { Request, RequestHandler } from "express"
import { HttpError } from "../../../utils/httpError"
import type { AuditContext } from "../../pieces-techniques/repository/pieces-techniques.repository"
import {
  addGammeOperationSchema,
  createGammeSchema,
  createGammeRevisionSchema,
  deleteGammeOperationSchema,
  publishGammeSchema,
  reorderOperationsSchema,
  updateGammeOperationSchema,
  updateGammeSchema,
} from "../validators/gammes.validators"
import {
  addGammeOperationSVC,
  createGammeSVC,
  createGammeRevisionSVC,
  deleteGammeOperationSVC,
  gammePublicationReadinessSVC,
  listGammeOperationsSVC,
  listGammesByVersionSVC,
  nextPhaseSVC,
  publishGammeSVC,
  reorderGammeOperationsSVC,
  updateGammeOperationSVC,
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

function routeParam(req: Request, name: string): string {
  const value = req.params[name]
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "INVALID_ROUTE_PARAM", `Paramètre de route invalide : ${name}`)
  }
  return value
}

export const listGammesByVersion: RequestHandler = async (req, res, next) => {
  try {
    const items = await listGammesByVersionSVC(routeParam(req, "versionId"))
    res.json(items)
  } catch (err) {
    next(err)
  }
}

export const createGamme: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = createGammeSchema.parse({ body: req.body }).body
    const out = await createGammeSVC(routeParam(req, "versionId"), body, audit)
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const updateGamme: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = updateGammeSchema.parse({ body: req.body }).body
    const out = await updateGammeSVC(routeParam(req, "gammeId"), body, audit)
    if (!out) throw new HttpError(404, "NOT_FOUND", "Gamme introuvable")
    res.json(out)
  } catch (err) {
    next(err)
  }
}

/**
 * #433 — Préparer une révision d'une gamme figée.
 *
 * `Idempotency-Key` est FACULTATIVE mais fortement recommandée : sans elle, un
 * double clic crée deux brouillons. L'écran en fournit une, stable tant que
 * l'utilisateur reste sur la même gamme.
 */
export const createGammeRevision: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = createGammeRevisionSchema.parse({ body: req.body }).body
    const rawKey = req.headers["idempotency-key"]
    const idempotencyKey = typeof rawKey === "string" && rawKey.trim() ? rawKey.trim().slice(0, 200) : null
    const out = await createGammeRevisionSVC(routeParam(req, "gammeId"), body, audit, idempotencyKey)
    res.status(out.replayed ? 200 : 201).json(out)
  } catch (err) {
    next(err)
  }
}

export const listGammeOperations: RequestHandler = async (req, res, next) => {
  try {
    const items = await listGammeOperationsSVC(routeParam(req, "gammeId"))
    res.json(items)
  } catch (err) {
    next(err)
  }
}

export const addGammeOperation: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = addGammeOperationSchema.parse({ body: req.body }).body
    const out = await addGammeOperationSVC(routeParam(req, "gammeId"), body, audit)
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const updateGammeOperation: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = updateGammeOperationSchema.parse({ body: req.body }).body
    const out = await updateGammeOperationSVC(
      routeParam(req, "gammeId"),
      routeParam(req, "operationId"),
      body,
      audit
    )
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const deleteGammeOperation: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = deleteGammeOperationSchema.parse({ body: req.body }).body
    await deleteGammeOperationSVC(
      routeParam(req, "gammeId"),
      routeParam(req, "operationId"),
      body.expected_updated_at,
      audit
    )
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}

/**
 * Prochain numéro de phase. `max(phase) + 10` par défaut ; un entier libre entre
 * deux phases avec `after_operation_id`. Le serveur reste autoritaire : l'interface
 * AFFICHE cette proposition, elle ne la recalcule pas dans son coin.
 */
export const nextGammeOperationPhase: RequestHandler = async (req, res, next) => {
  try {
    const after = typeof req.query.after_operation_id === "string" ? req.query.after_operation_id : null
    res.json(await nextPhaseSVC(routeParam(req, "gammeId"), after))
  } catch (err) {
    next(err)
  }
}

export const reorderGammeOperations: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = reorderOperationsSchema.parse({ body: req.body }).body
    const out = await reorderGammeOperationsSVC(routeParam(req, "gammeId"), body.order, audit)
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const readGammePublicationReadiness: RequestHandler = async (req, res, next) => {
  try {
    res.json(await gammePublicationReadinessSVC(routeParam(req, "gammeId")))
  } catch (err) {
    next(err)
  }
}

export const publishGamme: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = publishGammeSchema.parse({ body: req.body }).body
    res.json(await publishGammeSVC(routeParam(req, "gammeId"), body.expected_updated_at, audit))
  } catch (err) {
    next(err)
  }
}
