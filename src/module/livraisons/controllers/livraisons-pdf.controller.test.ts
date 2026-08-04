import type { NextFunction, Request, Response } from "express"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  availability: vi.fn(),
  generate: vi.fn(),
  getPath: vi.fn(),
  getName: vi.fn(),
  emitEntityChanged: vi.fn(),
}))

vi.mock("../services/pdf.service", () => ({
  svcGetLivraisonPdfAvailability: (...args: unknown[]) => mocks.availability(...args),
  svcGenerateLivraisonPdf: (...args: unknown[]) => mocks.generate(...args),
  svcGetPdfFilePath: (...args: unknown[]) => mocks.getPath(...args),
  svcGetDocumentName: (...args: unknown[]) => mocks.getName(...args),
}))

vi.mock("../../../shared/realtime/realtime.service", () => ({
  emitEntityChanged: (...args: unknown[]) => mocks.emitEntityChanged(...args),
}))

import {
  generateLivraisonPdf,
  getLivraisonPdf,
} from "./livraisons.controller"

const BL_ID = "11111111-1111-4111-8111-111111111111"

function responseDouble() {
  const response = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
    sendFile: vi.fn(),
  }
  response.status.mockReturnValue(response)
  return response
}

function requestDouble(overrides: Partial<Request> = {}) {
  return {
    user: { id: 7 },
    params: { id: BL_ID },
    query: {},
    headers: {},
    ...overrides,
  } as unknown as Request
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getPath.mockReturnValue("C:\\archives\\livraisons\\pdf.pdf")
  mocks.getName.mockResolvedValue("BL-0018.pdf")
})

describe("livraison PDF controller contract", () => {
  it("keeps GET read-only when no archive exists", async () => {
    mocks.availability.mockResolvedValue({
      available: false,
      status: "NOT_GENERATED",
      document_id: null,
      version: null,
      generated_at: null,
    })
    const response = responseDouble()
    const next = vi.fn() as NextFunction

    await getLivraisonPdf(requestDouble(), response as unknown as Response, next)

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404, code: "LIVRAISON_PDF_NOT_GENERATED" }),
    )
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(response.sendFile).not.toHaveBeenCalled()
  })

  it("does not mask authorization or storage failures from availability checks", async () => {
    const forbidden = Object.assign(new Error("Forbidden"), { status: 403, code: "FORBIDDEN" })
    mocks.availability.mockRejectedValue(forbidden)
    const response = responseDouble()
    const next = vi.fn() as NextFunction

    await getLivraisonPdf(requestDouble(), response as unknown as Response, next)

    expect(next).toHaveBeenCalledWith(forbidden)
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it("serves one requested archive version with private no-store caching", async () => {
    mocks.availability.mockResolvedValue({
      available: true,
      status: "AVAILABLE",
      document_id: "22222222-2222-4222-8222-222222222222",
      version: 3,
      generated_at: "2026-08-04T12:00:00.000Z",
    })
    const response = responseDouble()
    const next = vi.fn() as NextFunction

    await getLivraisonPdf(
      requestDouble({ query: { version: "3" } }),
      response as unknown as Response,
      next,
    )

    expect(mocks.availability).toHaveBeenCalledWith(BL_ID, 3)
    expect(response.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-store, max-age=0",
    )
    expect(response.sendFile).toHaveBeenCalledWith("C:\\archives\\livraisons\\pdf.pdf")
    expect(next).not.toHaveBeenCalled()
  })

  it("requires idempotency before explicit generation", async () => {
    const response = responseDouble()
    const next = vi.fn() as NextFunction

    await generateLivraisonPdf(requestDouble(), response as unknown as Response, next)

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ status: 400, code: "IDEMPOTENCY_KEY_REQUIRED" }),
    )
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it("returns a created immutable version for a new idempotency key", async () => {
    mocks.generate.mockResolvedValue({
      document_id: "22222222-2222-4222-8222-222222222222",
      version: 4,
      idempotent_replay: false,
    })
    const response = responseDouble()
    const next = vi.fn() as NextFunction

    await generateLivraisonPdf(
      requestDouble({ headers: { "idempotency-key": "generation-key-18" } }),
      response as unknown as Response,
      next,
    )

    expect(mocks.generate).toHaveBeenCalledWith(BL_ID, 7, "generation-key-18")
    expect(response.status).toHaveBeenCalledWith(201)
    expect(next).not.toHaveBeenCalled()
  })

  it("preserves the structured cancellation conflict from explicit generation", async () => {
    const conflict = Object.assign(new Error("Cancelled"), {
      status: 409,
      code: "LIVRAISON_CANCELLED_PDF_FORBIDDEN",
    })
    mocks.generate.mockRejectedValue(conflict)
    const response = responseDouble()
    const next = vi.fn() as NextFunction

    await generateLivraisonPdf(
      requestDouble({ headers: { "idempotency-key": "cancelled-generation" } }),
      response as unknown as Response,
      next,
    )

    expect(next).toHaveBeenCalledWith(conflict)
    expect(response.status).not.toHaveBeenCalled()
    expect(mocks.emitEntityChanged).not.toHaveBeenCalled()
  })
})
