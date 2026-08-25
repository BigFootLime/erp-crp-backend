import { describe, expect, it, vi } from "vitest"

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }))

vi.mock("../../../config/database", () => ({ default: { connect } }))
vi.mock("../../../shared/realtime/realtime-outbox.service", () => ({
  enqueueEntityChanged: vi.fn().mockResolvedValue("event-livraison"),
}))
vi.mock("../../../shared/authoritative-documents/authoritative-document.service", () => ({
  queueCreationPdfArchive: vi.fn().mockResolvedValue({ id: "archive-624" }),
}))
vi.mock("../services/delivery-authoritative-document", () => ({
  buildDeliveryCreationSnapshotInput: vi.fn().mockResolvedValue({}),
  buildShippedDeliveryArtifactInput: vi.fn().mockResolvedValue({}),
}))

import { repoCreateLivraisonLineAllocation } from "./livraisons.repository"
import { prepareLivraisonInTransaction } from "./livraisons-shipment.repository"

const ids = {
  delivery: "11111111-1111-4111-8111-111111111111",
  line: "22222222-2222-4222-8222-222222222222",
  article: "33333333-3333-4333-833333333333",
  lot: "44444444-4444-4444-8444-444444444444",
  magasin: "55555555-5555-4555-8555-555555555555",
  location: "66666666-6666-4666-8666-666666666666",
  level: "77777777-7777-4777-8777-777777777777",
  batch: "88888888-8888-4888-8888-888888888888",
  allocation: "99999999-9999-4999-8999-999999999999",
}

function allocationClient(
  lotStatus: "LIBERE" | "QUARANTAINE" | "EN_ATTENTE" | "BLOQUE",
  qtyOnHand = 10
) {
  const query = vi.fn(async (rawSql: unknown, _params?: unknown[]) => {
    const sql = String(rawSql)
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] }
    if (sql.includes("FROM public.bon_livraison_ligne line")) {
      return { rows: [{ id: ids.line, quantite: 2, commande_article_id: ids.article }] }
    }
    if (sql.includes("FROM bon_livraison bl") && sql.includes("FOR UPDATE OF bl")) {
      return { rows: [{ id: ids.delivery, numero: "BL-QUALITY", statut: "DRAFT" }] }
    }
    if (sql.includes("SUM(quantite)") && sql.includes("bon_livraison_ligne_allocations")) return { rows: [{ quantity: 0 }] }
    if (sql.includes("FROM public.articles")) return { rows: [{ stock_managed: true, lot_tracking: true }] }
    if (sql.includes("SELECT article_id::text AS article_id, lot_status FROM public.lots")) {
      return { rows: [{ article_id: ids.article, lot_status: lotStatus }] }
    }
    if (sql.includes("FROM public.emplacements e")) {
      return { rows: [{ magasin_id: ids.magasin, location_id: ids.location, warehouse_id: ids.magasin, emplacement_active: true, magasin_active: true, location_type: "STORAGE", allow_inbound: true, allow_outbound: true, restrictions: {} }] }
    }
    if (sql.includes("FROM public.stock_levels") && sql.includes("location_id")) return { rows: [{ id: ids.level }] }
    if (sql.includes("FROM public.stock_batches batch")) return { rows: [{ id: ids.batch }] }
    if (sql.includes("FROM public.stock_levels") && sql.includes("FOR UPDATE")) {
      return { rows: [{ qty_total: qtyOnHand, qty_reserved: 0, qty_depreciated: 0 }] }
    }
    if (sql.includes("FROM public.stock_batches") && sql.includes("FOR UPDATE")) {
      return { rows: [{ stock_level_id: ids.level, lot_id: ids.lot, qty_total: qtyOnHand, qty_reserved: 0, qty_depreciated: 0 }] }
    }
    if (sql.includes("SELECT lot_status FROM public.lots") && sql.includes("FOR SHARE")) return { rows: [{ lot_status: lotStatus }] }
    if (sql.includes("INSERT INTO public.bon_livraison_ligne_allocations")) return { rows: [{ id: ids.allocation }] }
    if (sql.includes("UPDATE bon_livraison SET")) return { rows: [] }
    if (sql.includes("INSERT INTO bon_livraison_event_log")) return { rows: [{ id: ids.allocation, created_at: "2026-08-23T00:00:00.000Z" }] }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
  return { query, release: vi.fn() }
}

const input = {
  article_id: ids.article,
  lot_id: ids.lot,
  magasin_id: ids.magasin,
  emplacement_id: 7,
  quantite: 2,
  unite: "PCS",
}

describe("DRAFT quarantine quality-scope allocation", () => {
  it("records a QUARANTAINE lot as scope only without reserving or moving stock", async () => {
    const client = allocationClient("QUARANTAINE")
    connect.mockResolvedValueOnce(client)

    await expect(repoCreateLivraisonLineAllocation(ids.delivery, ids.line, input, 7)).resolves.toEqual({ allocationId: ids.allocation })

    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.bon_livraison_ligne_allocations"))
    expect(insert?.[1]).toEqual([
      ids.line, ids.article, ids.lot, ids.magasin, 7, ids.location, ids.level, ids.batch,
      2, "PCS", 7,
    ])
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.stock_reservations"))).toBe(false)
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.stock_movement"))).toBe(false)
  })

  it.each(["EN_ATTENTE", "BLOQUE"] as const)("keeps %s lots out of the quality-scope path", async (lotStatus) => {
    const client = allocationClient(lotStatus)
    connect.mockResolvedValueOnce(client)

    await expect(repoCreateLivraisonLineAllocation(ids.delivery, ids.line, input, 7)).rejects.toMatchObject({
      status: 409,
      code: "LOT_NOT_CONSUMABLE",
    })
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.bon_livraison_ligne_allocations"))).toBe(false)
  })

  it("keeps the physical availability check for the QUARANTAINE scope path", async () => {
    const client = allocationClient("QUARANTAINE", 1)
    connect.mockResolvedValueOnce(client)

    await expect(repoCreateLivraisonLineAllocation(ids.delivery, ids.line, input, 7)).rejects.toMatchObject({
      status: 409,
      code: "INSUFFICIENT_STOCK",
    })
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.bon_livraison_ligne_allocations"))).toBe(false)
  })

  it("keeps preparation fail-closed until the scoped lot is released", async () => {
    const query = vi.fn(async (rawSql: unknown) => {
      const sql = String(rawSql)
      if (sql.includes("FROM public.bon_livraison delivery") && sql.includes("FOR UPDATE OF delivery")) {
        return { rows: [{
          id: ids.delivery,
          numero: "BL-QUALITY",
          statut: "DRAFT",
          row_version: 1,
          commande_id: "12",
          affaire_id: "7",
          order_type: "INTERNE",
          ar_sent_at: null,
        }] }
      }
      if (sql.includes("remainder.quantite_commandee::float8")) {
        return { rows: [{ id: ids.line, ordre: 1, quantite: 2, commande_ligne_id: 91, quantite_commandee: 2, quantite_expediee: 0, quantite_restante: 2 }] }
      }
      if (sql.includes("FROM public.bon_livraison_ligne_allocations allocation")) {
        return { rows: [{
          id: ids.allocation, bon_livraison_ligne_id: ids.line, line_order: 1, line_quantity: 2,
          article_id: ids.article, lot_id: ids.lot, lot_article_id: ids.article, lot_status: "QUARANTAINE",
          magasin_id: ids.magasin, emplacement_id: 7, location_id: ids.location, stock_level_id: ids.level,
          stock_batch_id: ids.batch, reservation_id: null, reservation_status: null, reservation_quantity: null,
          stock_movement_line_id: null, quantite: 2, unite: "PCS", qty_on_hand: 10, qty_reserved: 0,
          qty_depreciated: 0, pick_confirmed: false,
        }] }
      }
      if (sql.includes("FROM public.bon_livraison_pack_versions")) return { rows: [] }
      throw new Error(`Unexpected SQL: ${sql}`)
    })

    await expect(prepareLivraisonInTransaction({ query } as never, ids.delivery, 7)).rejects.toMatchObject({
      status: 409,
      code: "DELIVERY_PREPARATION_BLOCKED",
      details: { blockers: expect.arrayContaining([expect.objectContaining({ code: "LOT_NOT_RELEASED" })]) },
    })
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.stock_reservations"))).toBe(false)
  })
})
