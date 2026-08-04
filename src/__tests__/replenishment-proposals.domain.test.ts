import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  allocateCoverage,
  calculateReplenishment,
  convertOpenOrderRemainderToStock,
} from "../module/commande-fournisseur/domain/replenishment-calculation"
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

  it("converts every open-order remainder from purchase units to stock units", () => {
    expect(convertOpenOrderRemainderToStock({
      ordered_purchase_qty: 2,
      cancelled_purchase_qty: 0,
      received_purchase_qty: 0,
      purchase_unit: "barre",
      stock_unit: "kg",
      stock_units_per_purchase_unit: 2.5,
    })).toMatchObject({ remaining_purchase_qty: 2, remaining_stock_qty: 5, coefficient: 2.5, conversion_missing: false })

    expect(convertOpenOrderRemainderToStock({
      ordered_purchase_qty: 2,
      cancelled_purchase_qty: 0.25,
      received_purchase_qty: 0.5,
      purchase_unit: "barre",
      stock_unit: "kg",
      stock_units_per_purchase_unit: 2.5,
    }).remaining_stock_qty).toBe(3.125)
  })

  it("blocks an historical open remainder whose purchase-to-stock conversion is absent", () => {
    const remainder = convertOpenOrderRemainderToStock({
      ordered_purchase_qty: 2,
      cancelled_purchase_qty: 0,
      received_purchase_qty: 0,
      purchase_unit: "barre",
      stock_unit: "kg",
      stock_units_per_purchase_unit: null,
    })
    expect(remainder).toMatchObject({ remaining_stock_qty: 0, conversion_missing: true })
    expect(calculateReplenishment({ ...base, qty_open_orders: 0, open_order_conversion_missing: true }).missing_data)
      .toContain("OPEN_ORDER_UNIT_CONVERSION")
  })

  it("allocates coverage in exact positive milliunits without manufacturing quantity", () => {
    const levels = ["level-a", "level-b", "level-c"]

    expect(allocateCoverage(0.001, levels)).toEqual([
      { stock_level_id: "level-a", quantity: 0.001 },
    ])
    expect(allocateCoverage(0.002, levels)).toEqual([
      { stock_level_id: "level-a", quantity: 0.001 },
      { stock_level_id: "level-b", quantity: 0.001 },
    ])

    const split = allocateCoverage(0.005, levels.slice(0, 2))
    expect(split).toEqual([
      { stock_level_id: "level-a", quantity: 0.003 },
      { stock_level_id: "level-b", quantity: 0.002 },
    ])
    expect(Math.round(split.reduce((sum, item) => sum + item.quantity, 0) * 1000)).toBe(5)
    expect(split.every((item) => item.quantity > 0)).toBe(true)
    expect(allocateCoverage(0.0004, levels)).toEqual([])
    expect(allocateCoverage(10, [])).toEqual([])
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
    const preflight = fs.readFileSync(path.resolve("db/patches/support/20260805_replenishment_proposals.preflight.sql"), "utf8")
    const verify = fs.readFileSync(path.resolve("db/patches/support/20260805_replenishment_proposals.verify.sql"), "utf8")
    const rollback = fs.readFileSync(path.resolve("db/patches/support/20260805_replenishment_proposals.rollback.sql"), "utf8")
    const canonicalSha256 = createHash("sha256")
      .update(migration.replace(/\r\n?/g, "\n"), "utf8")
      .digest("hex")

    expect(migration).toMatch(/replenishment_proposals_article_site_uniq/)
    expect(migration).toMatch(/replenishment_proposals_article_unmapped_uniq/)
    expect(migration).toMatch(/stock_level_ids uuid\[\] NOT NULL/)
    expect(migration).toMatch(/replenishment_proposal_events_immutable/)
    expect(migration).toMatch(/commande_fournisseur_replenishment_idx/)
    expect(migration).toMatch(/UNIQUE \(actor_id, idempotency_key\)/)
    expect(migration).not.toMatch(/\b(?:CREATE TABLE|CREATE INDEX|ADD COLUMN)\s+IF NOT EXISTS/i)
    expect(migration).not.toMatch(/CREATE\s+OR\s+REPLACE/i)
    for (const lifecycleScript of [preflight, verify, rollback]) {
      expect(lifecycleScript).toContain(canonicalSha256)
      expect(lifecycleScript).toMatch(/cerp_schema_migrations/)
      expect(lifecycleScript).toMatch(/full target column shape is altered/)
      expect(lifecycleScript).toMatch(/owned constraint definition is altered/)
      expect(lifecycleScript).toMatch(/owned index definition is altered/)
      expect(lifecycleScript).toMatch(/owned trigger mapping\/event is altered/)
      expect(lifecycleScript).toMatch(/immutable function definition\/settings are altered/)
    }
    expect(preflight).toMatch(/BEGIN TRANSACTION READ ONLY/)
    expect(preflight).toMatch(/target artifact exists without migration ledger provenance/)
    expect(preflight).toMatch(/aclexplode/)
    expect(verify).toMatch(/BEGIN TRANSACTION READ ONLY/)
    expect(verify).toMatch(/module prefix is missing or duplicated/)
    expect(verify).toMatch(/aclexplode/)
    const repository = fs.readFileSync(path.resolve("src/module/commande-fournisseur/repository/replenishment-proposal.repository.ts"), "utf8")
    expect(repository).toMatch(/BEGIN ISOLATION LEVEL SERIALIZABLE/)
    expect(repository).toMatch(/FOR UPDATE OF p/)
    expect(repository).toMatch(/remaining_purchase_qty \* open_line\.stock_units_per_purchase_unit/)
    expect(repository).toMatch(/open_order_conversion_missing/)
    expect(repository).toMatch(/array_agg\(id::text ORDER BY id::text\) AS stock_level_ids/)
    expect(repository).toMatch(/GROUP BY article_id, magasin_id/)
    expect(repository).toMatch(/ON CONFLICT \$\{conflictTarget\}/)
    expect(rollback).toMatch(/restricted to cerp_dev\/cerp_test/)
    expect(rollback).toMatch(/pg_advisory_xact_lock/)
    expect(rollback).toMatch(/replenishment evidence or governed values exist/)
    expect(rollback).toMatch(/exact migration ledger row was not removed/)
    expect(rollback).not.toMatch(/DROP\s+(?:TABLE|INDEX|COLUMN|FUNCTION|TRIGGER)[\s\S]{0,80}\bIF EXISTS\b/i)
  })

  it("releases STOCK_LEVEL coverage transactionally for replacement while keeping active 23505 protection", () => {
    const orderRepository = fs.readFileSync(path.resolve("src/module/commande-fournisseur/repository/commande-fournisseur.repository.ts"), "utf8")
    const replenishmentRepository = fs.readFileSync(path.resolve("src/module/commande-fournisseur/repository/replenishment-proposal.repository.ts"), "utf8")
    expect(orderRepository).toMatch(/kind === "cancel"[\s\S]*UPDATE public\.commande_fournisseur_ligne_besoin besoin[\s\S]*SET annule = true/)
    expect(orderRepository.indexOf("SET annule = true")).toBeLessThan(orderRepository.indexOf('client.query("COMMIT")', orderRepository.indexOf("SET annule = true")))
    expect(replenishmentRepository).toMatch(/INSERT INTO public\.commande_fournisseur_ligne_besoin/)
    expect(replenishmentRepository).toMatch(/code === "23505"[\s\S]*REPLENISHMENT_ALREADY_CONVERTED/)
  })
})
