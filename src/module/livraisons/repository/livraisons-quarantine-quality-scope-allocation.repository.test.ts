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

import { repoCreateLivraisonLineAllocation, repoDeleteLivraisonLine, repoDeleteLivraisonLineAllocation } from "./livraisons.repository"
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

type SourceRow = {
  delivery_commande_id?: string | null
  delivery_affaire_id?: string | null
  line_commande_id?: string | null
  line_article_id?: string | null
  candidate_id?: string | null
  candidate_commande_id?: string | null
  candidate_commande_ligne_id?: string | null
  candidate_affaire_id?: string | null
  candidate_client_id?: string | null
  candidate_order_type?: string | null
  candidate_article_id?: string | null
}

function sourceRow(overrides: SourceRow = {}) {
  return {
    delivery_id: ids.delivery,
    delivery_commande_id: "12",
    delivery_affaire_id: "7",
    delivery_client_id: "1",
    line_id: ids.line,
    line_commande_ligne_id: "91",
    line_commande_id: "12",
    line_article_id: ids.article,
    candidate_id: "91",
    candidate_commande_id: "12",
    candidate_commande_ligne_id: "91",
    candidate_affaire_id: "7",
    candidate_client_id: "1",
    candidate_order_type: "FERME",
    candidate_article_id: ids.article,
    ...overrides,
  }
}

function allocationClient(
  lotStatus: "LIBERE" | "QUARANTAINE" | "EN_ATTENTE" | "BLOQUE",
  qtyOnHand = 10,
  snapshots: readonly (readonly SourceRow[])[] = [[sourceRow()], [sourceRow()]],
  headerScope = { allocation_rows: "1", incomplete_rows: "0", commande_count: "1", commande_id: "12", affaire_count: "1", affaire_id: "7" }
) {
  let snapshotRead = 0
  const query = vi.fn(async (rawSql: unknown, _params?: unknown[]) => {
    const sql = String(rawSql)
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] }
    if (sql.includes("fn_lock_delivery_prepayment_read_1268")) return { rows: [] }
    if (sql.includes("candidate.id::text AS candidate_id")) {
      return { rows: snapshots[Math.min(snapshotRead++, snapshots.length - 1)] ?? [] }
    }
    if (sql.includes("SELECT command.id FROM public.commande_client command")) return { rows: [] }
    if (sql.includes("delivery-contract-binding")) return { rows: [] }
    if (sql.includes("FROM public.commande_ligne_affaire_allocation allocation")) {
      const snapshot = snapshots[Math.min(snapshotRead - 1, snapshots.length - 1)] ?? []
      return { rows: snapshot.filter(row => row.candidate_id).map(row => ({ allocation_id: row.candidate_id })) }
    }
    if (sql.includes("pg_advisory_xact_lock_shared")) return { rows: [] }
    if (sql.includes("SELECT client_id::text FROM public.bon_livraison")) return { rows: [{ client_id: "1" }] }
    if (sql.includes("WITH delivery_scope AS")) {
      return { rows: [headerScope] }
    }
    if (sql.includes("WITH delivery_lines AS")) {
      return { rows: [{ commande_id: "12", client_id: "1", order_type: "FERME", contract_id: null, has_unbound_lines: false }] }
    }
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
    if (sql.includes("FROM public.bon_livraison_ligne_allocations bla") && sql.includes("GROUP BY bla.reservation_id")) return { rows: [] }
    if (sql.includes("FROM public.bon_livraison_ligne_allocations a") && sql.includes("FOR UPDATE")) {
      return { rows: [{ stock_movement_line_id: null, reservation_id: null }] }
    }
    if (sql.includes("DELETE FROM public.bon_livraison_ligne_allocations")) return { rows: [], rowCount: 1 }
    if (sql.includes("DELETE FROM bon_livraison_ligne WHERE")) return { rows: [], rowCount: 1 }
    if (sql.includes("UPDATE bon_livraison SET") || sql.includes("UPDATE public.bon_livraison")) return { rows: [] }
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
      91, 2, "PCS", 7,
    ])
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.stock_reservations"))).toBe(false)
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.stock_movement"))).toBe(false)
    const event = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO bon_livraison_event_log"))
    expect(JSON.parse(String(event?.[1]?.[3]))).toMatchObject({ commande_ligne_affaire_allocation_id: 91 })

    const queries = client.query.mock.calls.map(([sql]) => String(sql))
    const financeLock = queries.findIndex(sql => sql.includes("fn_lock_delivery_prepayment_read_1268"))
    const sourceLock = queries.findIndex(sql => sql.includes("SELECT command.id FROM public.commande_client command"))
    const deliveryLock = queries.findIndex(sql => sql.includes("FROM bon_livraison bl") && sql.includes("FOR UPDATE OF bl"))
    expect(financeLock).toBeGreaterThan(0)
    expect(sourceLock).toBeGreaterThan(financeLock)
    expect(deliveryLock).toBeGreaterThan(sourceLock)
  })

  it("keeps a legacy direct allocation unbound when there is no persisted source", async () => {
    const noSource = sourceRow({
      delivery_affaire_id: null,
      candidate_id: null,
      candidate_commande_id: null,
      candidate_commande_ligne_id: null,
      candidate_affaire_id: null,
      candidate_client_id: null,
      candidate_article_id: null,
    })
    const client = allocationClient("QUARANTAINE", 10, [[noSource], [noSource]])
    connect.mockResolvedValueOnce(client)

    await expect(repoCreateLivraisonLineAllocation(ids.delivery, ids.line, input, 7)).resolves.toEqual({ allocationId: ids.allocation })
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.bon_livraison_ligne_allocations"))
    expect(insert?.[1]).toContain(null)
  })

  it("binds a unique source for a multi-command BL when its line remains canonical", async () => {
    const multiCommandSource = sourceRow({ delivery_commande_id: null, delivery_affaire_id: null, line_article_id: null })
    const client = allocationClient("QUARANTAINE", 10, [[multiCommandSource], [multiCommandSource]])
    connect.mockResolvedValueOnce(client)

    await expect(repoCreateLivraisonLineAllocation(ids.delivery, ids.line, input, 7)).resolves.toEqual({ allocationId: ids.allocation })

    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.bon_livraison_ligne_allocations"))
    expect(insert?.[1]).toContain(91)
  })

  it("clears the aggregate header when canonical affaires are mixed and another line is unbound", async () => {
    const source = sourceRow({ candidate_affaire_id: "8" })
    const client = allocationClient(
      "QUARANTAINE",
      10,
      [[source], [source]],
      { allocation_rows: "2", incomplete_rows: "1", commande_count: "2", commande_id: "12", affaire_count: "2", affaire_id: "7" }
    )
    connect.mockResolvedValueOnce(client)

    await expect(repoCreateLivraisonLineAllocation(ids.delivery, ids.line, input, 7)).resolves.toEqual({ allocationId: ids.allocation })
    const reconciliation = client.query.mock.calls.find(([sql]) => String(sql).includes("SET commande_id = $2::bigint"))
    expect(reconciliation?.[1]).toEqual([ids.delivery, null, null, 7])
  })

  it("clears a removed allocation scope rather than retaining a stale affaire header", async () => {
    const client = allocationClient(
      "QUARANTAINE",
      10,
      [[sourceRow()], [sourceRow()]],
      { allocation_rows: "1", incomplete_rows: "0", commande_count: "1", commande_id: "12", affaire_count: "1", affaire_id: "8" }
    )
    connect.mockResolvedValueOnce(client)

    await expect(repoDeleteLivraisonLineAllocation(ids.delivery, ids.line, ids.allocation, 7)).resolves.toBe(true)
    const reconciliation = client.query.mock.calls.find(([sql]) => String(sql).includes("SET commande_id = $2::bigint"))
    expect(reconciliation?.[1]).toEqual([ids.delivery, "12", "8", 7])
  })

  it("reconciles the summary after deleting a complete line", async () => {
    const client = allocationClient(
      "QUARANTAINE",
      10,
      [[sourceRow()], [sourceRow()]],
      { allocation_rows: "1", incomplete_rows: "0", commande_count: "1", commande_id: "12", affaire_count: "1", affaire_id: "8" }
    )
    connect.mockResolvedValueOnce(client)

    await expect(repoDeleteLivraisonLine(ids.delivery, ids.line, 7)).resolves.toBe(true)
    const reconciliation = client.query.mock.calls.find(([sql]) => String(sql).includes("SET commande_id = $2::bigint"))
    expect(reconciliation?.[1]).toEqual([ids.delivery, "12", "8", 7])
  })

  it("preserves an internal order whose BL carries the configured delivery client", async () => {
    const internal = sourceRow({ candidate_client_id: null, candidate_order_type: "INTERNE" })
    const client = allocationClient("QUARANTAINE", 10, [[internal], [internal]])
    connect.mockResolvedValueOnce(client)

    await expect(repoCreateLivraisonLineAllocation(ids.delivery, ids.line, input, 7)).resolves.toEqual({ allocationId: ids.allocation })
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.bon_livraison_ligne_allocations"))
    expect(insert?.[1]?.[8]).toBe(91)
  })

  it("does not extend the internal-client exception to a customer order", async () => {
    const missingClient = sourceRow({ candidate_client_id: null, candidate_order_type: "FERME" })
    const client = allocationClient("QUARANTAINE", 10, [[missingClient], [missingClient]])
    connect.mockResolvedValueOnce(client)

    await expect(repoCreateLivraisonLineAllocation(ids.delivery, ids.line, input, 7)).rejects.toMatchObject({
      status: 409,
      code: "DELIVERY_ALLOCATION_SOURCE_MISMATCH",
    })
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.bon_livraison_ligne_allocations"))).toBe(false)
  })

  it.each([
    ["commande", { candidate_commande_id: "99" }],
    ["client", { candidate_client_id: "2" }],
    ["article", { candidate_article_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
  ] as const)("rejects a source with an incoherent %s identity", async (_label, override) => {
    const incoherent = sourceRow(override)
    const client = allocationClient("QUARANTAINE", 10, [[incoherent], [incoherent]])
    connect.mockResolvedValueOnce(client)

    await expect(repoCreateLivraisonLineAllocation(ids.delivery, ids.line, input, 7)).rejects.toMatchObject({
      status: 409,
      code: "DELIVERY_ALLOCATION_SOURCE_MISMATCH",
    })
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.bon_livraison_ligne_allocations"))).toBe(false)
  })

  it("accepts a unique canonical source when the BL header still names another affaire", async () => {
    const canonicalOtherAffaire = sourceRow({ candidate_affaire_id: "8" })
    const client = allocationClient("QUARANTAINE", 10, [[canonicalOtherAffaire], [canonicalOtherAffaire]])
    connect.mockResolvedValueOnce(client)

    await expect(repoCreateLivraisonLineAllocation(ids.delivery, ids.line, input, 7)).resolves.toEqual({ allocationId: ids.allocation })
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.bon_livraison_ligne_allocations"))
    expect(insert?.[1]).toContain(91)
    const headerScope = client.query.mock.calls.find(([sql]) => String(sql).includes("WITH delivery_scope AS"))
    expect(headerScope).toBeDefined()
  })

  it("rejects ambiguous canonical sources before it writes stock or the BL allocation", async () => {
    const first = sourceRow({ delivery_affaire_id: null })
    const second = sourceRow({ delivery_affaire_id: null, candidate_id: "92", candidate_affaire_id: "8" })
    const client = allocationClient("QUARANTAINE", 10, [[first, second], [first, second]])
    connect.mockResolvedValueOnce(client)

    await expect(repoCreateLivraisonLineAllocation(ids.delivery, ids.line, input, 7)).rejects.toMatchObject({
      status: 409,
      code: "DELIVERY_ALLOCATION_SOURCE_AMBIGUOUS",
    })
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.bon_livraison_ligne_allocations"))).toBe(false)
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.stock_reservations"))).toBe(false)
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.stock_movement"))).toBe(false)
  })

  it("rejects a provenance change after the Finance and BL locks", async () => {
    const before = sourceRow()
    const after = sourceRow({ candidate_id: "92" })
    const client = allocationClient("QUARANTAINE", 10, [[before], [after]])
    connect.mockResolvedValueOnce(client)

    await expect(repoCreateLivraisonLineAllocation(ids.delivery, ids.line, input, 7)).rejects.toMatchObject({
      status: 409,
      code: "DELIVERY_PREPAYMENT_SOURCE_CHANGED",
    })
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.bon_livraison_ligne_allocations"))).toBe(false)
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
      if (sql.includes("pg_advisory_xact_lock_shared")) return { rows: [] }
      if (sql.includes("fn_lock_delivery_prepayment_read_1268")) return { rows: [] }
      if (sql.includes("source.id IS NULL OR")) return { rows: [] }
      if (sql.includes("SELECT id FROM public.bon_livraison")) return { rows: [{ id: ids.delivery }] }
      if (sql.includes("SELECT client_id::text FROM public.bon_livraison")) return { rows: [{ client_id: "1" }] }
      if (sql.includes("WITH delivery_lines AS")) {
        return { rows: [{ commande_id: "12", client_id: null, order_type: "INTERNE", contract_id: null, has_unbound_lines: false }] }
      }
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
      if (sql.includes("WITH canonical_source_orders AS")) {
        return { rows: [{ commande_id: "12", order_type: "INTERNE", ar_sent_at: null }] }
      }
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
