// src/module/pieces-techniques/controllers/piece-article.controller.ts
// GPAO B5 — endpoints piece-side du lien Pièce technique ↔ Article fabriqué principal.
// Lecture côté canonique (articles.piece_technique_id). La création passe par le chemin
// transactionnel createStockArticleSVC (miroir articles + articles_fabrique + pieces_techniques.article_id).
import type { Request, RequestHandler } from "express"
import { z } from "zod"

import db from "../../../config/database"
import { HttpError } from "../../../utils/httpError"
import { repoGetPieceArticlePrincipal } from "../../stock/repository/article-piece-link.repository"
import type { AuditContext } from "../../stock/repository/stock.repository"
import { createStockArticleSVC } from "../../stock/services/stock.service"
import { createArticleSchema } from "../../stock/validators/stock.validators"

const uuidSchema = z.string().uuid()
const createOrLinkSchema = z.object({
  code: z.string().trim().min(1).max(80).optional(),
  designation: z.string().trim().min(1).max(400).optional(),
  family_code: z.string().trim().min(1).max(40),
  stock_managed: z.boolean().optional(),
})

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

// GET /pieces-techniques/:id/article-principal
export const getPieceArticlePrincipal: RequestHandler = async (req, res, next) => {
  try {
    const id = uuidSchema.parse(req.params.id)
    const piece = await db.query("SELECT 1 FROM public.pieces_techniques WHERE id = $1::uuid", [id])
    if (piece.rowCount === 0) {
      res.status(404).json({ error: "Pièce technique introuvable" })
      return
    }
    const article = await repoGetPieceArticlePrincipal(id)
    res.json({ article })
  } catch (err) {
    next(err)
  }
}

// POST /pieces-techniques/:id/create-or-link-article-fabrique { family_code, code?, designation?, stock_managed? }
export const createOrLinkArticleFabrique: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const id = uuidSchema.parse(req.params.id)
    const input = createOrLinkSchema.parse(req.body)

    const p = await db.query<{ code_piece: string; designation: string }>(
      "SELECT code_piece, designation FROM public.pieces_techniques WHERE id = $1::uuid",
      [id]
    )
    if (p.rowCount === 0) {
      res.status(404).json({ error: "Pièce technique introuvable" })
      return
    }

    // Déjà lié ? → on renvoie l'article existant (idempotent, pas de doublon).
    const existing = await repoGetPieceArticlePrincipal(id)
    if (existing) {
      res.status(200).json({ created: false, article: existing })
      return
    }

    const body = createArticleSchema.parse({
      body: {
        code: input.code ?? p.rows[0].code_piece,
        designation: input.designation ?? p.rows[0].designation,
        family_code: input.family_code,
        article_category: "fabrique",
        piece_technique_id: id,
        stock_managed: input.stock_managed ?? true,
      },
    }).body

    try {
      const article = await createStockArticleSVC(body, audit)
      res.status(201).json({ created: true, article })
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new HttpError(409, "ALREADY_LINKED", "Un article fabriqué existe déjà pour cette pièce (ou ce code article).")
      }
      throw e
    }
  } catch (err) {
    next(err)
  }
}
