import type { NextFunction, Request, Response } from "express"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createRevision: vi.fn(),
}))

vi.mock("../module/gammes/services/gammes.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../module/gammes/services/gammes.service")>()),
  createGammeRevisionSVC: mocks.createRevision,
}))

import { createGammeRevision } from "../module/gammes/controllers/gammes.controller"

const GAMME_ID = "11111111-1111-4111-8111-111111111111"

function requestWith(idempotencyKey?: string): Request {
  return {
    body: {},
    params: { gammeId: GAMME_ID },
    headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
    user: { id: 42, username: "methodes", role: "Directeur" },
    ip: "127.0.0.1",
    originalUrl: `/api/v1/gammes/${GAMME_ID}/revisions`,
  } as unknown as Request
}

function responseRecorder() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  }
  response.status.mockReturnValue(response)
  return response as unknown as Response
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("#433 — contrat HTTP de préparation d'une révision", () => {
  it.each([undefined, "short", "x".repeat(201)])(
    "refuse une Idempotency-Key absente ou hors bornes (%s)",
    async (key) => {
      const next = vi.fn() as NextFunction
      await createGammeRevision(requestWith(key), responseRecorder(), next)

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 400,
          code: "IDEMPOTENCY_KEY_REQUIRED",
        }),
      )
      expect(mocks.createRevision).not.toHaveBeenCalled()
    },
  )

  it("transmet une clé valide et rend 201 à la première création", async () => {
    const response = responseRecorder()
    const next = vi.fn() as NextFunction
    mocks.createRevision.mockResolvedValue({
      gamme: { id: "22222222-2222-4222-8222-222222222222" },
      operations_copied: 2,
      replayed: false,
    })

    await createGammeRevision(requestWith("revision-key-433"), response, next)

    expect(next).not.toHaveBeenCalled()
    expect(mocks.createRevision).toHaveBeenCalledWith(
      GAMME_ID,
      {},
      expect.objectContaining({ user_id: 42 }),
      "revision-key-433",
    )
    expect(response.status).toHaveBeenCalledWith(201)
  })

  it("rend 200 pour le rejeu de la même clé", async () => {
    const response = responseRecorder()
    const next = vi.fn() as NextFunction
    mocks.createRevision.mockResolvedValue({
      gamme: { id: "22222222-2222-4222-8222-222222222222" },
      operations_copied: 2,
      replayed: true,
    })

    await createGammeRevision(requestWith("revision-key-433"), response, next)

    expect(next).not.toHaveBeenCalled()
    expect(response.status).toHaveBeenCalledWith(200)
  })
})
