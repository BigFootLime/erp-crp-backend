import type { PoolClient } from "pg"
import { beforeEach, describe, expect, it, vi } from "vitest"

const dependencies = vi.hoisted(() => ({
  connect: vi.fn(),
  insertAudit: vi.fn(),
}))

vi.mock("../../../config/database", () => ({
  default: {
    connect: dependencies.connect,
    query: vi.fn(),
  },
}))

vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: dependencies.insertAudit,
}))

import {
  repoDeleteLivraisonLineAllocation,
  repoUpdateLivraisonStatus,
} from "./livraisons.repository"

const BON_LIVRAISON_ID = "44444444-4444-4444-8444-444444444444"
const LINE_ID = "55555555-5555-4555-8555-555555555555"
const ALLOCATION_ID = "66666666-6666-4666-8666-666666666666"
const RESERVATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const STOCK_LEVEL_ID = "88888888-8888-4888-8888-888888888888"
const STOCK_BATCH_ID = "99999999-9999-4999-8999-999999999999"
const LOT_ID = "22222222-2222-4222-8222-222222222222"
const USER_ID = 17

type LifecycleState = {
  deliveryStatus: "DRAFT" | "CANCELLED"
  allocationExists: boolean
  reservationStatus: "ACTIVE" | "RELEASED"
  stockLevelReserved: number
  stockBatchReserved: number
}

function createReservationAllocationLifecycle() {
  const state: LifecycleState = {
    deliveryStatus: "DRAFT",
    allocationExists: true,
    reservationStatus: "ACTIVE",
    stockLevelReserved: 4,
    stockBatchReserved: 4,
  }
  let snapshot: LifecycleState | null = null
  let failCancellationStatusUpdate = false

  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql === "BEGIN") {
      snapshot = { ...state }
      return { rows: [], rowCount: 0 }
    }
    if (sql === "COMMIT") {
      snapshot = null
      return { rows: [], rowCount: 0 }
    }
    if (sql === "ROLLBACK") {
      if (snapshot) Object.assign(state, snapshot)
      snapshot = null
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes("FROM bon_livraison bl")) {
      return {
        rows: [{
          id: BON_LIVRAISON_ID,
          numero: "BL-TEST-ORPHAN",
          statut: state.deliveryStatus,
          row_version: 1,
        }],
        rowCount: 1,
      }
    }
    if (sql.includes("SELECT a.stock_movement_line_id")) {
      return {
        rows: state.allocationExists ? [{ stock_movement_line_id: null }] : [],
        rowCount: state.allocationExists ? 1 : 0,
      }
    }
    if (sql.includes("DELETE FROM public.bon_livraison_ligne_allocations")) {
      const existed = state.allocationExists
      state.allocationExists = false
      return { rows: [], rowCount: existed ? 1 : 0 }
    }
    if (sql.includes("WITH target_reservation_ids AS")) {
      if (state.reservationStatus !== "ACTIVE") return { rows: [], rowCount: 0 }
      const row = {
        id: RESERVATION_ID,
        stock_level_id: STOCK_LEVEL_ID,
        stock_batch_id: STOCK_BATCH_ID,
        qty_reserved: 2,
      }
      // The duplicate exercises the defensive ID deduplication in addition to SQL UNION.
      return { rows: [row, { ...row }], rowCount: 2 }
    }
    if (sql.includes("FROM public.stock_levels") && sql.includes("FOR UPDATE")) {
      return {
        rows: [{ qty_total: 10, qty_reserved: state.stockLevelReserved, qty_depreciated: 0 }],
        rowCount: 1,
      }
    }
    if (sql.includes("FROM public.stock_batches") && sql.includes("FOR UPDATE")) {
      return {
        rows: [{
          stock_level_id: STOCK_LEVEL_ID,
          lot_id: LOT_ID,
          qty_total: 10,
          qty_reserved: state.stockBatchReserved,
          qty_depreciated: 0,
        }],
        rowCount: 1,
      }
    }
    if (sql.includes("FROM public.lots")) {
      return { rows: [{ lot_status: "LIBERE" }], rowCount: 1 }
    }
    if (sql.includes("UPDATE public.stock_levels")) {
      state.stockLevelReserved -= Number(values[1])
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes("UPDATE public.stock_batches")) {
      state.stockBatchReserved -= Number(values[1])
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes("UPDATE public.stock_reservations")) {
      state.reservationStatus = "RELEASED"
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes("UPDATE public.bon_livraison") && sql.includes("SET statut = $2")) {
      if (failCancellationStatusUpdate) throw new Error("status update failed")
      state.deliveryStatus = "CANCELLED"
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  })
  const client = { query, release: vi.fn() } as unknown as PoolClient
  return {
    client,
    query,
    state,
    failNextCancellationStatusUpdate() {
      failCancellationStatusUpdate = true
    },
  }
}

describe("annulation DRAFT après suppression de l'allocation", () => {
  beforeEach(() => {
    dependencies.connect.mockReset()
    dependencies.insertAudit.mockReset()
    dependencies.insertAudit.mockResolvedValue({ id: "audit-orphan" })
  })

  it("libère la réservation liée à la ligne et décrémente Stock exactement une fois", async () => {
    const lifecycle = createReservationAllocationLifecycle()
    dependencies.connect.mockResolvedValue(lifecycle.client)

    await expect(
      repoDeleteLivraisonLineAllocation(
        BON_LIVRAISON_ID,
        LINE_ID,
        ALLOCATION_ID,
        USER_ID
      )
    ).resolves.toBe(true)
    expect(lifecycle.state.allocationExists).toBe(false)
    expect(lifecycle.state.reservationStatus).toBe("ACTIVE")

    await expect(
      repoUpdateLivraisonStatus(BON_LIVRAISON_ID, "CANCELLED", USER_ID, {
        commentaire: "Allocation supprimée avant annulation",
      })
    ).resolves.toEqual({ id: BON_LIVRAISON_ID, statut: "CANCELLED" })

    expect(lifecycle.state).toEqual({
      deliveryStatus: "CANCELLED",
      allocationExists: false,
      reservationStatus: "RELEASED",
      stockLevelReserved: 2,
      stockBatchReserved: 2,
    })
    const targetQuery = lifecycle.query.mock.calls.find(([sql]) =>
      String(sql).includes("WITH target_reservation_ids AS")
    )
    expect(String(targetQuery?.[0])).toContain("reservation.bon_livraison_ligne_id")
    expect(String(targetQuery?.[0])).toContain("UNION")
    expect(String(targetQuery?.[0])).toContain("bon_livraison_ligne_allocations")
  })

  it("restaure réservation et quantités si l'annulation échoue après la libération", async () => {
    const lifecycle = createReservationAllocationLifecycle()
    dependencies.connect.mockResolvedValue(lifecycle.client)

    await repoDeleteLivraisonLineAllocation(
      BON_LIVRAISON_ID,
      LINE_ID,
      ALLOCATION_ID,
      USER_ID
    )
    lifecycle.failNextCancellationStatusUpdate()

    await expect(
      repoUpdateLivraisonStatus(BON_LIVRAISON_ID, "CANCELLED", USER_ID, {
        commentaire: "Rollback après libération",
      })
    ).rejects.toThrow("status update failed")

    expect(lifecycle.state).toEqual({
      deliveryStatus: "DRAFT",
      allocationExists: false,
      reservationStatus: "ACTIVE",
      stockLevelReserved: 4,
      stockBatchReserved: 4,
    })
    expect(dependencies.insertAudit).not.toHaveBeenCalled()
    expect(lifecycle.query).toHaveBeenCalledWith("ROLLBACK")
  })
})
