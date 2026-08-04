import type { NextFunction, Request, Response } from "express"
import { beforeEach, describe, expect, it, vi } from "vitest"

const pdf = vi.hoisted(() => ({
  generate: vi.fn(),
  getLatest: vi.fn(),
}))

vi.mock("../services/pdf.service", () => ({
  svcGenerateLivraisonPdf: pdf.generate,
  svcGetDocumentName: vi.fn(),
  svcGetLatestLivraisonPdfDocument: pdf.getLatest,
  svcGetPdfFilePath: vi.fn(),
}))

import { getLivraisonPdf } from "./livraisons.controller"

const BON_LIVRAISON_ID = "00000000-0000-4000-8000-000000000017"

describe("GET automatique du PDF d'un bon de livraison annulé", () => {
  beforeEach(() => {
    pdf.generate.mockReset()
    pdf.getLatest.mockReset()
  })

  it("propage le conflit structuré quand l'absence d'archive déclenche une génération", async () => {
    const conflict = {
      status: 409,
      code: "LIVRAISON_CANCELLED_PDF_FORBIDDEN",
      message: "Un bon de livraison annulé ne peut pas générer ou régénérer de PDF.",
    }
    pdf.getLatest.mockResolvedValue(null)
    pdf.generate.mockRejectedValue(conflict)
    const request = {
      params: { id: BON_LIVRAISON_ID },
      query: {},
      user: { id: 17 },
    } as unknown as Request
    const response = {} as Response
    const next = vi.fn() as NextFunction

    await getLivraisonPdf(request, response, next)

    expect(pdf.getLatest).toHaveBeenCalledWith(BON_LIVRAISON_ID)
    expect(pdf.generate).toHaveBeenCalledWith(BON_LIVRAISON_ID, 17)
    expect(next).toHaveBeenCalledWith(conflict)
  })
})
