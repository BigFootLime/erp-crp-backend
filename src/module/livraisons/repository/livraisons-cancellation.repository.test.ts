import type { PoolClient } from "pg"
import { beforeEach, describe, expect, it, vi } from "vitest"

const testState = vi.hoisted(() => ({
  connect: vi.fn(),
  insertAudit: vi.fn(),
  releaseReservations: vi.fn(),
}))

vi.mock("../../../config/database", () => ({
  default: {
    connect: testState.connect,
    query: vi.fn(),
  },
}))

vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: testState.insertAudit,
}))

vi.mock("./livraisons-shipment.repository", () => ({
  prepareLivraisonInTransaction: vi.fn(),
  releaseLivraisonReservationsInTransaction: testState.releaseReservations,
  repoListLivraisonProofs: vi.fn(),
}))

import { repoUpdateLivraisonStatus } from "./livraisons.repository"

const BON_LIVRAISON_ID = "00000000-0000-4000-8000-000000000017"
const USER_ID = 17

function createClient(currentStatus: "DRAFT" | "READY" | "CANCELLED", updateRowCount = 1) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes("FROM bon_livraison bl")) {
      return {
        rows: [{
          id: BON_LIVRAISON_ID,
          numero: "BL-TEST-0017",
          statut: currentStatus,
          row_version: 1,
        }],
      }
    }
    if (sql.includes("UPDATE public.bon_livraison")) {
      return { rows: [], rowCount: updateRowCount }
    }
    return { rows: [], rowCount: 0 }
  })
  const client = { query, release: vi.fn() } as unknown as PoolClient
  return { client, query }
}

describe("transaction d'annulation d'un bon de livraison", () => {
  beforeEach(() => {
    testState.connect.mockReset()
    testState.insertAudit.mockReset()
    testState.releaseReservations.mockReset()
    testState.insertAudit.mockResolvedValue({ id: "audit-17" })
    testState.releaseReservations.mockResolvedValue(undefined)
  })

  it("libère les réservations READY avec le même motif avant la mutation", async () => {
    const { client, query } = createClient("READY")
    testState.connect.mockResolvedValue(client)

    await expect(
      repoUpdateLivraisonStatus(BON_LIVRAISON_ID, "CANCELLED", USER_ID, {
        commentaire: "  Commande client abandonnée  ",
      })
    ).resolves.toEqual({ id: BON_LIVRAISON_ID, statut: "CANCELLED" })

    expect(testState.releaseReservations).toHaveBeenCalledWith(
      client,
      BON_LIVRAISON_ID,
      USER_ID,
      "Commande client abandonnée"
    )
    const updateCallIndex = query.mock.calls.findIndex(([sql]) =>
      String(sql).includes("UPDATE public.bon_livraison")
    )
    expect(testState.releaseReservations.mock.invocationCallOrder[0]).toBeLessThan(
      query.mock.invocationCallOrder[updateCallIndex]
    )
    expect(testState.insertAudit).toHaveBeenCalledOnce()
  })

  it("conserve le DRAFT et écrit l'événement et l'audit avant COMMIT", async () => {
    const { client, query } = createClient("DRAFT")
    testState.connect.mockResolvedValue(client)

    await expect(
      repoUpdateLivraisonStatus(BON_LIVRAISON_ID, "CANCELLED", USER_ID, {
        commentaire: "  Doublon de saisie confirmé  ",
      })
    ).resolves.toEqual({ id: BON_LIVRAISON_ID, statut: "CANCELLED" })

    const eventCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO bon_livraison_event_log")
    )
    expect(eventCall?.[1]).toEqual([
      BON_LIVRAISON_ID,
      "STATUS_CHANGED",
      JSON.stringify({ statut: "DRAFT" }),
      JSON.stringify({ statut: "CANCELLED", commentaire: "Doublon de saisie confirmé" }),
      USER_ID,
    ])
    expect(testState.insertAudit).toHaveBeenCalledWith(expect.objectContaining({
      user_id: USER_ID,
      tx: client,
      body: expect.objectContaining({
        action: "livraisons.cancelled",
        entity_id: BON_LIVRAISON_ID,
        details: {
          bon_livraison_numero: "BL-TEST-0017",
          old_statut: "DRAFT",
          new_statut: "CANCELLED",
          reason: "Doublon de saisie confirmé",
        },
      }),
    }))

    const auditOrder = testState.insertAudit.mock.invocationCallOrder[0]
    const commitOrder = query.mock.calls.findIndex(([sql]) => sql === "COMMIT")
    expect(auditOrder).toBeLessThan(query.mock.invocationCallOrder[commitOrder])
  })

  it("refuse un motif vide avant toute mutation et ROLLBACK", async () => {
    const { client, query } = createClient("DRAFT")
    testState.connect.mockResolvedValue(client)

    await expect(
      repoUpdateLivraisonStatus(BON_LIVRAISON_ID, "CANCELLED", USER_ID, {
        commentaire: "   ",
      })
    ).rejects.toMatchObject({ status: 422, code: "CANCELLATION_REASON_REQUIRED" })

    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE public.bon_livraison"))).toBe(false)
    expect(query).toHaveBeenCalledWith("ROLLBACK")
    expect(testState.insertAudit).not.toHaveBeenCalled()
  })

  it("ne duplique ni événement ni audit lors d'un rejeu idempotent", async () => {
    const { client, query } = createClient("CANCELLED")
    testState.connect.mockResolvedValue(client)

    await expect(
      repoUpdateLivraisonStatus(BON_LIVRAISON_ID, "CANCELLED", USER_ID, {
        commentaire: "Confirmation du rejeu",
      })
    ).resolves.toEqual({ id: BON_LIVRAISON_ID, statut: "CANCELLED" })

    expect(query.mock.calls.some(([sql]) => String(sql).includes("bon_livraison_event_log"))).toBe(false)
    expect(testState.insertAudit).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledWith("COMMIT")
  })

  it("annule toute la transaction si le statut change malgré le verrou", async () => {
    const { client, query } = createClient("DRAFT", 0)
    testState.connect.mockResolvedValue(client)

    await expect(
      repoUpdateLivraisonStatus(BON_LIVRAISON_ID, "CANCELLED", USER_ID, {
        commentaire: "Annulation concurrente",
      })
    ).rejects.toMatchObject({ status: 409, code: "CONCURRENT_MODIFICATION" })

    expect(query).toHaveBeenCalledWith("ROLLBACK")
    expect(testState.insertAudit).not.toHaveBeenCalled()
  })
})
