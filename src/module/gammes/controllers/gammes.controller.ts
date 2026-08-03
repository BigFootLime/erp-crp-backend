// src/module/gammes/controllers/gammes.controller.ts
// GPAO B2.2 — HTTP handlers gammes + opérations de gamme.
import type { Request, RequestHandler } from "express"
import { HttpError } from "../../../utils/httpError"
import { parseUuidRouteParam } from "../../../utils/routeParams"
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

export const listGammesByVersion: RequestHandler = async (req, res, next) => {
  try {
    const items = await listGammesByVersionSVC(parseUuidRouteParam(req.params, "versionId"))
    res.json(items)
  } catch (err) {
    next(err)
  }
}

export const createGamme: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = createGammeSchema.parse({ body: req.body }).body
    const out = await createGammeSVC(parseUuidRouteParam(req.params, "versionId"), body, audit)
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const updateGamme: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = updateGammeSchema.parse({ body: req.body }).body
    const out = await updateGammeSVC(parseUuidRouteParam(req.params, "gammeId"), body, audit)
    if (!out) throw new HttpError(404, "NOT_FOUND", "Gamme introuvable")
    res.json(out)
  } catch (err) {
    next(err)
  }
}

/**
 * #433 — Préparer une révision d'une gamme figée.
 *
 * `Idempotency-Key` est OBLIGATOIRE : l'API ne doit pas dépendre du seul
 * comportement de l'écran pour garantir qu'un double clic ou un rejeu après
 * coupure ne crée pas deux brouillons.
 */
export const createGammeRevision: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = createGammeRevisionSchema.parse({ body: req.body }).body
    const rawKey = req.headers["idempotency-key"]
    const idempotencyKey = typeof rawKey === "string" ? rawKey.trim() : ""
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new HttpError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Une clé Idempotency-Key stable de 8 à 200 caractères est obligatoire."
      )
    }
    const out = await createGammeRevisionSVC(parseUuidRouteParam(req.params, "gammeId"), body, audit, idempotencyKey)
    res.status(out.replayed ? 200 : 201).json(out)
  } catch (err) {
    next(err)
  }
}

export const listGammeOperations: RequestHandler = async (req, res, next) => {
  try {
    const items = await listGammeOperationsSVC(parseUuidRouteParam(req.params, "gammeId"))
    res.json(items)
  } catch (err) {
    next(err)
  }
}

export const addGammeOperation: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = addGammeOperationSchema.parse({ body: req.body }).body
    const out = await addGammeOperationSVC(parseUuidRouteParam(req.params, "gammeId"), body, audit)
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
      parseUuidRouteParam(req.params, "gammeId"),
      parseUuidRouteParam(req.params, "operationId"),
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
      parseUuidRouteParam(req.params, "gammeId"),
      parseUuidRouteParam(req.params, "operationId"),
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
    res.json(await nextPhaseSVC(parseUuidRouteParam(req.params, "gammeId"), after))
  } catch (err) {
    next(err)
  }
}

export const reorderGammeOperations: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = reorderOperationsSchema.parse({ body: req.body }).body
    const out = await reorderGammeOperationsSVC(parseUuidRouteParam(req.params, "gammeId"), body.order, audit)
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const readGammePublicationReadiness: RequestHandler = async (req, res, next) => {
  try {
    res.json(await gammePublicationReadinessSVC(parseUuidRouteParam(req.params, "gammeId")))
  } catch (err) {
    next(err)
  }
}

export const publishGamme: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const body = publishGammeSchema.parse({ body: req.body }).body
    res.json(await publishGammeSVC(parseUuidRouteParam(req.params, "gammeId"), body.expected_updated_at, audit))
  } catch (err) {
    next(err)
  }
}
