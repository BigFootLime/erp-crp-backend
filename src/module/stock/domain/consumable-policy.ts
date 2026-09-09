import { HttpError } from "../../../utils/httpError";
import { purchaseQuantity, quantity } from "../../production/domain/of-material";

export type ConsumptionMode = "UNIT" | "GLOBAL_PACK";
export type ConsumablePolicy = {
  internal_reference?: string | null;
  consumption_mode?: ConsumptionMode;
  purchase_pack_qty?: number;
  receipt_quality_required?: boolean;
};

export function assertConsumablePolicy(input: ConsumablePolicy & {
  article_categories: readonly string[]; stock_managed: boolean; lot_tracking: boolean;
}) {
  const consumable = input.article_categories.includes("consommable");
  if (!consumable && (input.consumption_mode === "GLOBAL_PACK" || input.receipt_quality_required === false)) {
    throw new HttpError(422, "CONSUMABLE_CATEGORY_REQUIRED", "Ce mode de consommation et l’entrée directe sont réservés aux consommables.");
  }
  if (input.consumption_mode === "GLOBAL_PACK" && (!input.stock_managed || !input.lot_tracking)) {
    throw new HttpError(422, "CONSUMABLE_PACK_TRACKING_REQUIRED", "Le suivi global exige un stock géré et des conditionnements identifiés.");
  }
}

/** Catalogue conditions are in purchase units; article defaults are in stock units. */
export function consumablePurchaseQuantity(input: {
  shortage: number; articlePack: number; supplierMinimum?: number | null;
  supplierPack?: number | null; coefficient?: number;
}) {
  const coefficient = input.coefficient ?? 1;
  if (!Number.isFinite(coefficient) || coefficient <= 0) throw new HttpError(422, "CONSUMABLE_UNIT_REQUIRED", "La conversion de l’unité d’achat doit être positive.");
  const purchase = purchaseQuantity(input.shortage / coefficient, input.supplierMinimum ?? null,
    input.supplierPack ?? input.articlePack / coefficient);
  return { ordered: purchase.ordered, assigned: quantity(input.shortage),
    stockQuantity: quantity(purchase.ordered * coefficient), surplus: quantity(purchase.ordered * coefficient - input.shortage) };
}

/** A shared pack is availability, never a quantitative reservation for every OF. */
export function sharedPackCoverage(availablePacks: number, pendingQuantity: number) {
  return { available: availablePacks > 0, shared: true as const,
    state: availablePacks > 0 ? "SHARED_AVAILABLE" : pendingQuantity > 0 ? "EXPECTED" : "MISSING" };
}

export function assertPackDepletion(input: { total: number; reserved: number; expected: number }) {
  if (input.reserved > 0) throw new HttpError(409, "PACK_RESERVED", "Ce conditionnement porte une réservation. Faites-la traiter avant de le solder.");
  if (input.total <= 0) throw new HttpError(409, "PACK_ALREADY_EMPTY", "Ce conditionnement est déjà soldé.");
  if (quantity(input.expected) !== quantity(input.total)) throw new HttpError(409, "PACK_CHANGED", "Le reliquat a changé. Relisez le conditionnement avant de confirmer.");
  return quantity(input.total);
}
