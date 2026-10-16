import type { PoolClient } from "pg"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock("../../../config/database", () => ({ default: { connect: mocks.connect } }))

import {
  assertDeliveryCustomerAcknowledgement,
  readDeliveryCustomerAcknowledgementSources,
} from "./delivery-customer-acknowledgement.repository"
import { repoShipLivraison } from "./livraisons.repository"

const deliveryId = "11111111-1111-4111-8111-111111111111"

function queryWithSources(rows: Array<{ commande_id: string; order_type: string | null; ar_sent_at: string | null }>) {
  return vi.fn(async () => ({ rows }))
}

describe("delivery customer acknowledgement boundary (#1365)", () => {
  it("blocks a mixed canonical delivery when one external source has no AR", async () => {
    const query = queryWithSources([
      { commande_id: "101", order_type: "FERME", ar_sent_at: "2026-10-16T00:00:00.000Z" },
      { commande_id: "102", order_type: "FERME", ar_sent_at: null },
    ])

    await expect(assertDeliveryCustomerAcknowledgement({ query } as unknown as PoolClient, deliveryId))
      .rejects.toMatchObject({ status: 409, code: "CUSTOMER_ACKNOWLEDGEMENT_REQUIRED" })
  })

  it("allows sent external ARs while retaining the INTERNE exception", async () => {
    const query = queryWithSources([
      { commande_id: "101", order_type: "FERME", ar_sent_at: "2026-10-16T00:00:00.000Z" },
      { commande_id: "102", order_type: "FERME", ar_sent_at: "2026-10-16T00:01:00.000Z" },
      { commande_id: "103", order_type: "INTERNE", ar_sent_at: null },
    ])

    await expect(assertDeliveryCustomerAcknowledgement({ query } as unknown as PoolClient, deliveryId)).resolves.toBeUndefined()
    await expect(readDeliveryCustomerAcknowledgementSources({ query } as unknown as PoolClient, deliveryId)).resolves.toHaveLength(3)
  })

  it("rejects the legacy shipment mutation before any pack or stock write when an AR is missing", async () => {
    const query = vi.fn(async (rawSql: unknown) => {
      const sql = String(rawSql)
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] }
      if (sql.includes("INSERT INTO public.bon_livraison_ship_receipts")) return { rows: [{ id: "receipt-1" }] }
      if (sql.includes("canonical_source_orders")) return { rows: [{ commande_id: "101", order_type: "FERME", ar_sent_at: null }] }
      if (sql.includes("SELECT public.fn_lock_delivery_prepayment_read_1268")) return { rows: [] }
      if (sql.includes("FROM public.bon_livraison_ligne line") && sql.includes("allocation_id")) return { rows: [] }
      if (sql.includes("SELECT id FROM public.bon_livraison WHERE")) return { rows: [] }
      if (sql.includes("SELECT id::text AS id, numero, statut, shipping_version")) {
        return { rows: [{ id: deliveryId, numero: "BL-TEST", statut: "READY", shipping_version: 1 }] }
      }
      if (sql.includes("pg_advisory_xact_lock_shared")) return { rows: [] }
      if (sql.includes("SELECT client_id::text FROM public.bon_livraison")) return { rows: [{ client_id: "client-1" }] }
      if (sql.includes("WITH delivery_lines AS")) return { rows: [] }
      throw new Error(`Unexpected query: ${sql.slice(0, 100)}`)
    })
    const release = vi.fn()
    mocks.connect.mockResolvedValueOnce({ query, release })

    await expect(repoShipLivraison({
      bon_livraison_id: deliveryId,
      body: { expected_shipping_version: 1, preview_hash: "a".repeat(64) },
      user_id: 7,
      idempotency_key: "00000000-0000-4000-8000-000000000001",
    })).rejects.toMatchObject({ status: 409, code: "CUSTOMER_ACKNOWLEDGEMENT_REQUIRED" })
    expect(query.mock.calls.some(([sql]) => String(sql).includes("bon_livraison_pack_versions"))).toBe(false)
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.stock_movements"))).toBe(false)
    expect(release).toHaveBeenCalledOnce()
  })
})
