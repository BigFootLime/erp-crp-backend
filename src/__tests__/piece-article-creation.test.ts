import type { Request, Response } from "express"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ query: vi.fn(), principal: vi.fn(), create: vi.fn() }))
vi.mock("../config/database", () => ({ default: { query: mocks.query } }))
vi.mock("../module/stock/repository/article-piece-link.repository", () => ({ repoGetPieceArticlePrincipal: mocks.principal }))
vi.mock("../module/stock/services/stock.service", () => ({ createStockArticleSVC: mocks.create }))

import { createOrLinkArticleFabrique } from "../module/pieces-techniques/controllers/piece-article.controller"
import { HttpError } from "../utils/httpError"

const pieceId = "11111111-1111-4111-8111-111111111111"
const article = { id: "22222222-2222-4222-8222-222222222222", code: "001-PLAN-A-P1" }

async function createFromPiece(body: Record<string, unknown> = { family_code: "FAB-GEN" }) {
  const req = { params: { id: pieceId }, body, user: { id: 42 }, headers: {}, originalUrl: `/pieces-techniques/${pieceId}/create-or-link-article-fabrique` } as unknown as Request
  const res = { status: vi.fn(), json: vi.fn() }
  res.status.mockReturnValue(res)
  const next = vi.fn()
  await createOrLinkArticleFabrique(req, res as unknown as Response, next)
  return { res, next }
}

describe("Manufactured article creation from a customer technical piece", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.query.mockResolvedValue({ rowCount: 1, rows: [{ code_piece: "001-PLAN-A", designation: "Test piece", client_id: "001" }] })
    mocks.principal.mockResolvedValue(null)
    mocks.create.mockResolvedValue(article)
  })

  it("supplies the canonical piece customer to the transactional stock creation service", async () => {
    const { res, next } = await createFromPiece()
    expect(next).not.toHaveBeenCalled()
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ commercial_scope: "CLIENTS", client_ids: ["001"], piece_technique_id: pieceId, article_category: "fabrique" }), expect.objectContaining({ user_id: 42 }), `piece-article-${pieceId}`)
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith({ created: true, article })
  })

  it("returns the existing link without changing its commercial scope or creating a duplicate", async () => {
    mocks.principal.mockResolvedValue(article)
    mocks.query.mockResolvedValue({ rowCount: 1, rows: [{ code_piece: "001-PLAN-A", designation: "Test piece", client_id: null }] })
    const { res, next } = await createFromPiece()
    expect(next).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ created: false, article })
  })

  it("refuses to invent a customer or CRP reference for an unlinked piece without a customer", async () => {
    mocks.query.mockResolvedValue({ rowCount: 1, rows: [{ code_piece: "PLAN-A", designation: "Test piece", client_id: null }] })
    const { next } = await createFromPiece()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422, code: "ARTICLE_CLIENT_REQUIRED" }))
    expect(next.mock.calls[0][0]).toBeInstanceOf(HttpError)
  })

  it("does not accept a browser-supplied customer override", async () => {
    const { next } = await createFromPiece({ family_code: "FAB-GEN", client_ids: ["002"] })
    expect(next).toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
