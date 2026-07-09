// src/module/stock/controllers/article-piece-link.controller.ts
// GPAO B5 — endpoints article-side du lien Article fabriqué ↔ Pièce technique.
// Le lien passe par le chemin transactionnel updateStockArticleSVC (miroir articles +
// pieces_techniques.article_id + articles_fabrique). Aucune écriture directe hors transaction.
import type { Request, RequestHandler } from "express"
import { z } from "zod"

import db from "../../../config/database"
import { HttpError } from "../../../utils/httpError"
import { repoGetArticleDefinitionTechnique } from "../repository/article-piece-link.repository"
import type { AuditContext } from "../repository/stock.repository"
import { getStockArticleSVC, updateStockArticleSVC } from "../services/stock.service"
import { updateArticleSchema } from "../validators/stock.validators"

const uuidSchema = z.string().uuid()
const linkBodySchema = z.object({ piece_technique_id: uuidSchema })

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

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505"
}

// GET /stock/articles/:id/definition-technique
export const getArticleDefinitionTechnique: RequestHandler = async (req, res, next) => {
  try {
    const id = uuidSchema.parse(req.params.id)
    const out = await repoGetArticleDefinitionTechnique(id)
    if (!out) {
      res.status(404).json({ error: "Article introuvable" })
      return
    }
    res.json(out)
  } catch (err) {
    next(err)
  }
}

// POST /stock/articles/:id/link-piece-technique { piece_technique_id }
export const linkArticlePieceTechnique: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const id = uuidSchema.parse(req.params.id)
    const { piece_technique_id } = linkBodySchema.parse(req.body)

    const article = await getStockArticleSVC(id)
    if (!article) {
      res.status(404).json({ error: "Article introuvable" })
      return
    }
    if (article.article_category !== "fabrique") {
      throw new HttpError(409, "NOT_FABRIQUE", "Seul un article fabriqué peut être lié à une pièce technique")
    }

    const piece = await db.query("SELECT 1 FROM public.pieces_techniques WHERE id = $1::uuid", [piece_technique_id])
    if (piece.rowCount === 0) {
      throw new HttpError(404, "PIECE_NOT_FOUND", "Pièce technique introuvable")
    }

    // Chemin transactionnel : met à jour articles + miroir pieces_techniques.article_id + articles_fabrique.
    const body = updateArticleSchema.parse({ body: { piece_technique_id } }).body
    try {
      const out = await updateStockArticleSVC(id, body, audit)
      res.json(out)
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new HttpError(409, "PIECE_ALREADY_LINKED", "Cette pièce est déjà liée à un autre article fabriqué")
      }
      throw e
    }
  } catch (err) {
    next(err)
  }
}

// DELETE /stock/articles/:id/link-piece-technique
// Un article 'fabrique' NE PEUT PAS avoir piece_technique_id NULL (CHECK articles_piece_type_consistency).
// On refuse donc proprement (recatégoriser d'abord). Pour un article non-fabriqué, il n'y a rien à délier.
export const unlinkArticlePieceTechnique: RequestHandler = async (req, res, next) => {
  try {
    const id = uuidSchema.parse(req.params.id)
    const article = await getStockArticleSVC(id)
    if (!article) {
      res.status(404).json({ error: "Article introuvable" })
      return
    }
    if (article.article_category === "fabrique") {
      throw new HttpError(
        409,
        "FABRIQUE_REQUIRES_PIECE",
        "Un article fabriqué doit conserver une pièce technique. Recatégorisez l'article avant de délier."
      )
    }
    res.json({ ok: true, message: "Aucune pièce technique liée à délier pour cet article." })
  } catch (err) {
    next(err)
  }
}
