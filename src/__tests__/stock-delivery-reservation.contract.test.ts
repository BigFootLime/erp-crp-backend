import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ofReceiptBodySchema } from "../module/production/validators/production.validators";
import {
  correctPreparationStockBodySchema,
  createLivraisonFromReservationsBodySchema,
  preparationCartQuerySchema,
  shipLivraisonBodySchema,
  verifyPreparationLotBodySchema,
} from "../module/livraisons/validators/livraisons.validators";

const uuid = "11111111-1111-4111-8111-111111111111";
const patchDir = path.resolve(__dirname, "../../db/patches");
const supportDir = path.join(patchDir, "support");
const patch = fs.readFileSync(path.join(patchDir, "20260826_commandes_stock_reservations_livraisons_atomic.sql"), "utf8");
const commandRepository = fs.readFileSync(
  path.resolve(__dirname, "../module/commande-client/repository/commande-client.repository.ts"),
  "utf8"
);
const deliveryRepository = fs.readFileSync(
  path.resolve(__dirname, "../module/livraisons/repository/livraisons.repository.ts"),
  "utf8"
);
const stockRepository = fs.readFileSync(
  path.resolve(__dirname, "../module/stock/repository/stock.repository.ts"),
  "utf8"
);
const livraisonRoutes = fs.readFileSync(
  path.resolve(__dirname, "../module/livraisons/routes/livraisons.routes.ts"),
  "utf8"
);
const canonicalScopePatch = fs.readFileSync(
  path.join(patchDir, "20260826_z_lots_scope_canonicalization.sql"),
  "utf8"
);

describe("Commande → stock → OF receipt → delivery contracts", () => {
  it("requires an OF version and a reason for a non-released receipt", () => {
    const base = {
      article_id: uuid,
      qty_ok: 2,
      location_id: uuid,
      lot_mode: "EXISTING" as const,
      lot_id: uuid,
      quality_status: "LIBERE" as const,
      expected_of_updated_at: "2026-08-26T10:00:00.000Z",
    };
    expect(ofReceiptBodySchema.safeParse(base).success).toBe(true);
    expect(ofReceiptBodySchema.safeParse({ ...base, expected_of_updated_at: undefined }).success).toBe(false);
    expect(ofReceiptBodySchema.safeParse({ ...base, quality_status: "QUARANTAINE" }).success).toBe(false);
    expect(ofReceiptBodySchema.safeParse({ ...base, quality_status: "QUARANTAINE", quality_reason: "Contrôle requis" }).success).toBe(
      true
    );

    const declaredLosses = ofReceiptBodySchema.parse({ ...base, qty_scrap: 0.25, qty_rework: 1 });
    expect(declaredLosses.qty_scrap).toBe(0.25);
    expect(declaredLosses.qty_rework).toBe(1);
    expect(ofReceiptBodySchema.safeParse({ ...base, qty_scrap: -0.01 }).success).toBe(false);
    expect(ofReceiptBodySchema.safeParse({ ...base, qty_rework: -0.01 }).success).toBe(false);
  });

  it("validates only reservation-backed cart, scan, correction and atomic ship DTOs", () => {
    const cart = preparationCartQuerySchema.parse({ commande_id: "42", affaire_id: "7" });
    expect(cart).toMatchObject({ commande_id: 42, affaire_id: 7, page: 1, pageSize: 100 });
    expect(
      verifyPreparationLotBodySchema.safeParse({
        reservation_id: uuid,
        qty: 1,
        scanned_lot_code: "LOT-0001",
        of_number: "OF-0001",
        mp_reference: "MP-01",
        tr_reference: "TR-01",
      }).success
    ).toBe(true);
    expect(correctPreparationStockBodySchema.safeParse({ reservation_id: uuid, reason: "écart compté" }).success).toBe(false);
    expect(
      correctPreparationStockBodySchema.safeParse({
        reservation_id: uuid,
        reason: "Écart de comptage physique",
        actual_qty: 0,
      }).success
    ).toBe(true);
    expect(
      correctPreparationStockBodySchema.safeParse({
        reservation_id: uuid,
        reason: "Étiquette de lot corrigée",
        lot_code: "LOT-0002",
      }).success
    ).toBe(true);
    expect(
      createLivraisonFromReservationsBodySchema.safeParse({ items: [{ reservation_id: uuid, qty: 1 }] }).success
    ).toBe(true);
    expect(shipLivraisonBodySchema.safeParse({ expected_shipping_version: 1, preview_hash: "a".repeat(64) }).success).toBe(true);
    expect(shipLivraisonBodySchema.safeParse({ expected_shipping_version: 1, preview_hash: "stale" }).success).toBe(false);
  });

  it("keeps the migration additive, preserves audit ledgers and supplies support scripts", () => {
    expect(patch).toMatch(/ADD COLUMN IF NOT EXISTS source_scope/);
    expect(patch).toMatch(/CREATE TABLE IF NOT EXISTS public\.of_receipts/);
    expect(patch).toMatch(/CREATE TABLE IF NOT EXISTS public\.stock_reservation_corrections/);
    expect(patch).toMatch(/CREATE TABLE IF NOT EXISTS public\.bon_livraison_ship_receipts/);
    expect(patch).toMatch(/CREATE TABLE IF NOT EXISTS public\.bon_livraison_prepare_receipts/);
    expect(patch).toMatch(/stock_reservations_active_allocation_batch_uniq/);
    expect(patch).toMatch(/qty_consumed \+ qty_prepared <= qty_reserved/);
    expect(patch).toMatch(/requested_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
    expect(patch).toMatch(/delivery_status/);
    expect(patch).not.toMatch(/DROP\s+TABLE/i);
    expect(patch).not.toMatch(/TRUNCATE/i);
    expect(fs.existsSync(path.join(supportDir, "20260826_commandes_stock_reservations_livraisons_atomic.verify.sql"))).toBe(true);
    expect(fs.existsSync(path.join(supportDir, "20260826_commandes_stock_reservations_livraisons_atomic.rollback.sql"))).toBe(true);
  });

  it("enforces OLD→NEW FIFO, released lots, row locks and idempotent preparation/shipment/correction ledgers", () => {
    expect(commandRepository).toMatch(/WHEN lot\.origin_stock_scope = 'OLD' THEN 0[\s\S]*COALESCE\(lot\.source_scope, lot\.stock_scope, warehouse\.stock_scope, 'NEW'\) = 'OLD' THEN 0/);
    expect(commandRepository).toMatch(/COALESCE\(lot\.lot_status, 'LIBERE'\) = 'LIBERE'/);
    expect(commandRepository).toMatch(/FROM public\.lots WHERE id = \$1::uuid FOR UPDATE/);
    expect(commandRepository).toMatch(/FROM public\.stock_levels[\s\S]*FOR UPDATE/);
    expect(commandRepository).toMatch(/FROM public\.stock_batches[\s\S]*FOR UPDATE/);
    expect(deliveryRepository).toMatch(/FOR UPDATE OF bla, r, sb, sl, l/);
    expect(deliveryRepository).toMatch(/bon_livraison_ship_receipts/);
    expect(deliveryRepository).toMatch(/bon_livraison_prepare_receipts/);
    expect(deliveryRepository).toMatch(/RESERVATION_ALREADY_PREPARED/);
    expect(deliveryRepository).toMatch(/qty_prepared = qty_prepared \+ \$2/);
    expect(deliveryRepository).toMatch(/qty_consumed \+ \$3 <= quantite/);
    expect(deliveryRepository).toMatch(/stock_reservation_corrections/);
    expect(deliveryRepository).toMatch(/'ADJUSTMENT'::public\.movement_type/);
    expect(deliveryRepository).not.toMatch(/ACTUAL_QTY_BELOW_RESERVED/);
    expect(deliveryRepository).toMatch(/PHYSICAL_QTY_BELOW_PREPARED/);
    expect(deliveryRepository).toMatch(/reallocateCorrectedBatchReservations/);
    expect(deliveryRepository).toMatch(/prepareOfsForReservationShortages/);
    expect(deliveryRepository).toMatch(/createRecursiveOrdresFabrication/);
    expect(deliveryRepository).toMatch(/CASE COALESCE\(l\.source_scope, l\.stock_scope, w\.stock_scope, 'NEW'\) WHEN 'OLD' THEN 0 ELSE 1 END/);
    expect(deliveryRepository).toMatch(/MP_SCAN_MISMATCH/);
    expect(deliveryRepository).toMatch(/TR_SCAN_MISMATCH/);
    expect(deliveryRepository).toMatch(/body\.of_number !== undefined && body\.of_number !== reservation\.of_numero/);
    expect(deliveryRepository).toMatch(/requested_at = now\(\)/);
    expect(deliveryRepository).toMatch(/plan_reference/);
    expect(deliveryRepository).toMatch(/plan_index/);
    expect(deliveryRepository).toMatch(/verified_qty/);
    expect(stockRepository).toMatch(/AS of_references/);
    expect(stockRepository).toMatch(/AS mp_references/);
    expect(stockRepository).toMatch(/AS tr_references/);
    expect(stockRepository).toMatch(/public\.of_output_lots/);
    expect(livraisonRoutes).toMatch(/preparation-cart\/correct/);
    expect(livraisonRoutes).toMatch(/requireStockCorrectionPermission/);
    expect(livraisonRoutes).toMatch(/:id\/print-status/);
    expect(livraisonRoutes).toMatch(/:id\/print\/retry/);
  });

  it("makes source_scope canonical while keeping stock_scope synchronized for older article readers", () => {
    expect(canonicalScopePatch).toMatch(/tg_lots_sync_scope_columns/);
    expect(canonicalScopePatch).toMatch(/BEFORE INSERT OR UPDATE OF source_scope, stock_scope/);
    expect(canonicalScopePatch).toMatch(/NEW\.stock_scope := NEW\.source_scope/);
    expect(fs.existsSync(path.join(supportDir, "20260826_z_lots_scope_canonicalization.verify.sql"))).toBe(true);
  });
});
