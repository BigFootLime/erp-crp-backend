import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { NextFunction, Request, Response } from "express"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  availability: vi.fn(),
  read: vi.fn(),
  generate: vi.fn(),
  getPath: vi.fn(),
  getName: vi.fn(),
  emitEntityChanged: vi.fn(),
}))

vi.mock("../services/pdf.service", () => ({
  svcGetLivraisonPdfAvailability: (...args: unknown[]) => mocks.availability(...args),
  svcReadLivraisonPdf: (...args: unknown[]) => mocks.read(...args),
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
    send: vi.fn(),
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
    mocks.read.mockResolvedValue({
      available: false,
      status: "NOT_GENERATED",
      document_id: null,
      version: null,
      generated_at: null,
      bytes: null,
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

  it("does not mask authorization or storage failures from archive reads", async () => {
    const forbidden = Object.assign(new Error("Forbidden"), { status: 403, code: "FORBIDDEN" })
    mocks.read.mockRejectedValue(forbidden)
    const response = responseDouble()
    const next = vi.fn() as NextFunction

    await getLivraisonPdf(requestDouble(), response as unknown as Response, next)

    expect(next).toHaveBeenCalledWith(forbidden)
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it("serves one requested archive version with private no-store caching", async () => {
    const validatedBytes = Buffer.from("%PDF-1.7\nvalidated")
    mocks.read.mockResolvedValue({
      available: true,
      status: "AVAILABLE",
      document_id: "22222222-2222-4222-8222-222222222222",
      version: 3,
      generated_at: "2026-08-04T12:00:00.000Z",
      bytes: validatedBytes,
    })
    const response = responseDouble()
    const next = vi.fn() as NextFunction

    await getLivraisonPdf(
      requestDouble({ query: { version: "3" } }),
      response as unknown as Response,
      next,
    )

    expect(mocks.read).toHaveBeenCalledWith(BL_ID, 3)
    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "application/pdf")
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      'inline; filename="BL-0018.pdf"',
    )
    expect(response.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-store, max-age=0",
    )
    expect(response.send).toHaveBeenCalledWith(validatedBytes)
    expect(response.sendFile).not.toHaveBeenCalled()
    expect(mocks.getPath).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it("serves the validated buffer when the archived path is replaced before send", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-pdf-controller-"))
    const archivePath = path.join(directory, "archive.pdf")
    const validatedBytes = Buffer.from("%PDF-1.7\nvalidated-original")
    const replacementBytes = Buffer.from("%PDF-1.7\nreplaced-after-validation")
    const expectedChecksum = crypto.createHash("sha256").update(validatedBytes).digest("hex")
    let serviceBytes: Buffer | null = null

    try {
      await fs.writeFile(archivePath, validatedBytes)
      mocks.read.mockImplementation(async () => {
        serviceBytes = await fs.readFile(archivePath)
        expect(crypto.createHash("sha256").update(serviceBytes).digest("hex")).toBe(
          expectedChecksum,
        )
        return {
          available: true,
          status: "AVAILABLE",
          document_id: "22222222-2222-4222-8222-222222222222",
          version: 3,
          generated_at: "2026-08-04T12:00:00.000Z",
          bytes: serviceBytes,
        }
      })
      mocks.getName.mockImplementation(async () => {
        await fs.writeFile(archivePath, replacementBytes)
        return "BL-0018.pdf"
      })
      const response = responseDouble()
      const next = vi.fn() as NextFunction

      await getLivraisonPdf(
        requestDouble({ query: { version: "3" } }),
        response as unknown as Response,
        next,
      )

      await expect(fs.readFile(archivePath)).resolves.toEqual(replacementBytes)
      expect(response.send).toHaveBeenCalledWith(serviceBytes)
      expect(response.send).not.toHaveBeenCalledWith(replacementBytes)
      expect(response.sendFile).not.toHaveBeenCalled()
      expect(next).not.toHaveBeenCalled()
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
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
