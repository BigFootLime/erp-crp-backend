import { beforeEach, describe, expect, it, vi } from "vitest"

const repository = vi.hoisted(() => ({
  getDetail: vi.fn(),
  getDocumentName: vi.fn(),
}))

const database = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
}))

vi.mock("../../../config/database", () => ({
  default: database,
}))

vi.mock("../repository/livraisons.repository", () => ({
  repoGetLivraisonDetail: repository.getDetail,
  repoGetDocumentName: repository.getDocumentName,
}))

import {
  svcGenerateLivraisonPdf,
  svcGetLatestLivraisonPdfDocument,
} from "./pdf.service"

const BON_LIVRAISON_ID = "00000000-0000-4000-8000-000000000017"

describe("garde PDF d'un bon de livraison annulé", () => {
  beforeEach(() => {
    repository.getDetail.mockReset()
    repository.getDocumentName.mockReset()
    database.connect.mockReset()
    database.query.mockReset()
  })

  it("conserve la lecture de l'archive historique existante", async () => {
    database.query.mockResolvedValue({ rows: [{ document_id: "pdf-historique", version: 3 }] })

    await expect(svcGetLatestLivraisonPdfDocument(BON_LIVRAISON_ID)).resolves.toEqual({
      document_id: "pdf-historique",
      version: 3,
    })
  })

  it("bloque la génération sous verrou avant chargement du détail ou écriture du fichier", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT statut FROM public.bon_livraison")) {
        return { rows: [{ statut: "CANCELLED" }] }
      }
      return { rows: [] }
    })
    database.connect.mockResolvedValue({ query, release: vi.fn() })

    await expect(svcGenerateLivraisonPdf(BON_LIVRAISON_ID, 17)).rejects.toMatchObject({
      status: 409,
      code: "LIVRAISON_CANCELLED_PDF_FORBIDDEN",
    })

    expect(repository.getDetail).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT statut[\s\S]*FOR UPDATE/),
      [BON_LIVRAISON_ID]
    )
    expect(query).toHaveBeenCalledWith("ROLLBACK")
  })
})
