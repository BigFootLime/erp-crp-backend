import { beforeEach, describe, expect, it, vi } from "vitest"

const repository = vi.hoisted(() => ({
  getStatut: vi.fn(),
  updateStatus: vi.fn(),
}))

vi.mock("../repository/livraisons.repository", () => ({
  repoAddLivraisonLine: vi.fn(),
  repoAttachLivraisonDocuments: vi.fn(),
  repoCreateLivraison: vi.fn(),
  repoCreateLivraisonLineAllocation: vi.fn(),
  repoCreateLivraisonFromCommande: vi.fn(),
  repoDeleteLivraisonLineAllocation: vi.fn(),
  repoDeleteLivraisonLine: vi.fn(),
  repoGetLivraisonDetail: vi.fn(),
  repoGetLivraisonStatut: repository.getStatut,
  repoListLivraisons: vi.fn(),
  repoRemoveLivraisonDocument: vi.fn(),
  repoUpdateLivraisonHeader: vi.fn(),
  repoUpdateLivraisonLine: vi.fn(),
  repoUpdateLivraisonStatus: repository.updateStatus,
}))

vi.mock("../repository/livraisons-shipment.repository", () => ({
  repoCreateLivraisonProof: vi.fn(),
  repoGetLivraisonShipmentPreview: vi.fn(),
  repoShipLivraison: vi.fn(),
}))

import { svcUpdateLivraisonStatus } from "./livraisons.service"

const BON_LIVRAISON_ID = "00000000-0000-4000-8000-000000000017"
const USER_ID = 17

describe("annulation auditée d'un bon de livraison", () => {
  beforeEach(() => {
    repository.getStatut.mockReset()
    repository.updateStatus.mockReset()
    repository.updateStatus.mockResolvedValue({
      id: BON_LIVRAISON_ID,
      statut: "CANCELLED",
    })
  })

  it.each(["DRAFT", "READY"] as const)(
    "autorise %s -> CANCELLED avec un motif normalisé",
    async (current) => {
      repository.getStatut.mockResolvedValue(current)

      await expect(
        svcUpdateLivraisonStatus(
          BON_LIVRAISON_ID,
          { statut: "CANCELLED", commentaire: "  Commande client abandonnée  " },
          USER_ID
        )
      ).resolves.toEqual({ id: BON_LIVRAISON_ID, statut: "CANCELLED" })

      expect(repository.updateStatus).toHaveBeenCalledWith(
        BON_LIVRAISON_ID,
        "CANCELLED",
        USER_ID,
        { commentaire: "Commande client abandonnée" }
      )
    }
  )

  it.each(["DRAFT", "READY"] as const)(
    "refuse %s -> CANCELLED sans motif",
    async (current) => {
      repository.getStatut.mockResolvedValue(current)

      await expect(
        svcUpdateLivraisonStatus(
          BON_LIVRAISON_ID,
          { statut: "CANCELLED", commentaire: "   " },
          USER_ID
        )
      ).rejects.toMatchObject({
        status: 422,
        code: "CANCELLATION_REASON_REQUIRED",
      })
      expect(repository.updateStatus).not.toHaveBeenCalled()
    }
  )

  it.each(["SHIPPED", "DELIVERED"] as const)(
    "refuse l'annulation depuis l'état %s",
    async (current) => {
      repository.getStatut.mockResolvedValue(current)

      await expect(
        svcUpdateLivraisonStatus(
          BON_LIVRAISON_ID,
          { statut: "CANCELLED", commentaire: "Motif documenté" },
          USER_ID
        )
      ).rejects.toMatchObject({ status: 409, code: "INVALID_TRANSITION" })
      expect(repository.updateStatus).not.toHaveBeenCalled()
    }
  )

  it("conserve l'idempotence de CANCELLED avec un motif explicite", async () => {
    repository.getStatut.mockResolvedValue("CANCELLED")

    await expect(
      svcUpdateLivraisonStatus(
        BON_LIVRAISON_ID,
        { statut: "CANCELLED", commentaire: "Confirmation de l'annulation" },
        USER_ID
      )
    ).resolves.toEqual({ id: BON_LIVRAISON_ID, statut: "CANCELLED" })

    expect(repository.updateStatus).toHaveBeenCalledOnce()
  })

  it("propage un conflit détecté sous verrou sans annoncer de faux succès", async () => {
    repository.getStatut.mockResolvedValue("DRAFT")
    repository.updateStatus.mockRejectedValueOnce(
      Object.assign(new Error("Le statut du BL a changé."), {
        status: 409,
        code: "CONCURRENT_MODIFICATION",
      })
    )

    await expect(
      svcUpdateLivraisonStatus(
        BON_LIVRAISON_ID,
        { statut: "CANCELLED", commentaire: "Doublon confirmé" },
        USER_ID
      )
    ).rejects.toMatchObject({ status: 409, code: "CONCURRENT_MODIFICATION" })
  })
})
