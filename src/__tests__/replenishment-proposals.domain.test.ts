import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { calculateReplenishment } from "../module/commande-fournisseur/domain/replenishment-calculation"
import { validateReplenishmentProposalSchema } from "../module/commande-fournisseur/validators/replenishment-proposal.validators"

const UUID = "3b9f2a44-6d3e-4f7a-9c2d-1e5b8a7c6d90"
const base = {
  qty_on_hand: 4,
  qty_reserved: 1,
  qty_available: 3,
  qty_open_orders: 2,
  minimum_stock_qty: 8,
  safety_stock_qty: 2,
  target_stock_qty: null,
  reorder_qty: null,
  stock_unit: "kg",
  purchase_unit: "barre",
  stock_units_per_purchase_unit: 2.5,
  supplier_moq: 3,
  purchase_lot_size: 2,
  unit_price: 10,
}

describe("FEAT-CERP-0003 replenishment calculation", () => {
  it("subtracts available stock and open orders, then applies MOQ, conversion and lot rounding", () => {
    const result = calculateReplenishment(base)
    expect(result.target_stock_qty).toBe(10)
    expect(result.gross_requirement_qty).toBe(7)
    expect(result.net_requirement_qty).toBe(5)
    expect(result.proposed_purchase_qty).toBe(4)
    expect(result.proposed_stock_qty).toBe(10)
    expect(result.estimated_total).toBe(40)
    expect(result.warnings).toContain("MOQ_APPLIED")
    expect(result.warnings).toContain("PURCHASE_LOT_ROUNDED")
  })

  it("a receipt replacing incoming quantity with available stock does not recreate a need", () => {
    const before = calculateReplenishment(base)
    const after = calculateReplenishment({ ...base, qty_on_hand: 6, qty_available: 5, qty_open_orders: 0 })
    expect(before.net_requirement_qty).toBe(after.net_requirement_qty)
  })

  it("an open order can resolve the proposal and missing thresholds remain explicit", () => {
    expect(calculateReplenishment({ ...base, qty_open_orders: 20 }).reason_code).toBe("COUVERT")
    const incomplete = calculateReplenishment({ ...base, minimum_stock_qty: null, safety_stock_qty: null })
    expect(incomplete.reason_code).toBe("SEUIL_MANQUANT")
    expect(incomplete.missing_data).toContain("MINIMUM_STOCK")
    expect(incomplete.warnings).toContain("SAFETY_STOCK_MISSING")
  })

  it("blocks an ungoverned unit conversion", () => {
    const result = calculateReplenishment({ ...base, stock_units_per_purchase_unit: null })
    expect(result.proposed_purchase_qty).toBeNull()
    expect(result.missing_data).toContain("UNIT_CONVERSION")
  })
})

describe("FEAT-CERP-0003 boundaries", () => {
  it("requires optimistic version, supplier catalogue and idempotency key", () => {
    expect(validateReplenishmentProposalSchema.safeParse({
      params: { id: UUID },
      body: { catalogue_id: UUID, expected_version: 1, idempotency_key: "validate-0001" },
    }).success).toBe(true)
    expect(validateReplenishmentProposalSchema.safeParse({ params: { id: UUID }, body: { catalogue_id: UUID } }).success).toBe(false)
  })

  it("migration carries deduplication, append-only audit, order linkage and guarded rollback", () => {
    const migration = fs.readFileSync(path.resolve("db/patches/20260805_replenishment_proposals.sql"), "utf8")
    const rollback = fs.readFileSync(path.resolve("db/patches/support/20260805_replenishment_proposals.rollback.sql"), "utf8")
    expect(migration).toMatch(/UNIQUE \(stock_level_id\)/)
    expect(migration).toMatch(/replenishment_proposal_events_immutable/)
    expect(migration).toMatch(/commande_fournisseur_replenishment_idx/)
    expect(migration).toMatch(/UNIQUE \(actor_id, idempotency_key\)/)
    const repository = fs.readFileSync(path.resolve("src/module/commande-fournisseur/repository/replenishment-proposal.repository.ts"), "utf8")
    expect(repository).toMatch(/BEGIN ISOLATION LEVEL SERIALIZABLE/)
    expect(repository).toMatch(/FOR UPDATE OF p/)
    expect(rollback).toMatch(/restricted to cerp_test/)
    expect(rollback).toMatch(/Rollback refused/)
  })
})
