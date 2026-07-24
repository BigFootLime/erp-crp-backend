export type StockLotQualityStatus = "LIBERE" | "EN_ATTENTE" | "QUARANTAINE" | "BLOQUE" | null;

export type StockAvailabilityInput = {
  qty_on_hand: number;
  qty_reserved: number;
  qty_depreciated: number;
  lot_status: StockLotQualityStatus;
};

export type StockAvailability = {
  qty_on_hand: number;
  qty_reserved: number;
  qty_depreciated: number;
  qty_quarantine: number;
  qty_blocked: number;
  qty_available: number;
};

export type NegativeStockOverride = {
  maximum_negative_qty: number;
  reason: string;
};

export type NegativeStockOverrideEvaluation = {
  allowed: boolean;
  projected_qty_on_hand: number;
  code:
    | "ALLOWED"
    | "INVALID_LIMIT"
    | "LOT_NOT_RELEASED"
    | "RESERVED_STOCK_PRESENT"
    | "DEPRECIATED_STOCK_PRESENT"
    | "LIMIT_EXCEEDED";
};

function nonNegative(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(value, 0);
}

export function calculateStockAvailability(input: StockAvailabilityInput): StockAvailability {
  const qtyOnHand = nonNegative(input.qty_on_hand);
  const qtyReserved = nonNegative(input.qty_reserved);
  const qtyDepreciated = nonNegative(input.qty_depreciated);
  const physicalNetOfDepreciation = nonNegative(qtyOnHand - qtyDepreciated);
  const isQuarantine = input.lot_status === "EN_ATTENTE" || input.lot_status === "QUARANTAINE";
  const isBlocked = input.lot_status === "BLOQUE";
  const isReleased = input.lot_status === null || input.lot_status === "LIBERE";

  return {
    qty_on_hand: qtyOnHand,
    qty_reserved: qtyReserved,
    qty_depreciated: qtyDepreciated,
    qty_quarantine: isQuarantine ? physicalNetOfDepreciation : 0,
    qty_blocked: isBlocked ? physicalNetOfDepreciation : 0,
    qty_available: isReleased ? nonNegative(qtyOnHand - qtyReserved - qtyDepreciated) : 0,
  };
}

export function evaluateNegativeStockOverride(
  input: StockAvailabilityInput,
  consumedQty: number,
  override: NegativeStockOverride
): NegativeStockOverrideEvaluation {
  const projectedQtyOnHand = input.qty_on_hand - Math.abs(consumedQty);
  const deny = (
    code: Exclude<NegativeStockOverrideEvaluation["code"], "ALLOWED">
  ): NegativeStockOverrideEvaluation => ({
    allowed: false,
    projected_qty_on_hand: projectedQtyOnHand,
    code,
  });

  if (
    !Number.isFinite(override.maximum_negative_qty) ||
    override.maximum_negative_qty <= 0
  ) {
    return deny("INVALID_LIMIT");
  }
  if (input.lot_status !== null && input.lot_status !== "LIBERE") {
    return deny("LOT_NOT_RELEASED");
  }
  if (input.qty_reserved > 1e-9) {
    return deny("RESERVED_STOCK_PRESENT");
  }
  if (input.qty_depreciated > 1e-9) {
    return deny("DEPRECIATED_STOCK_PRESENT");
  }
  if (projectedQtyOnHand < -override.maximum_negative_qty - 1e-9) {
    return deny("LIMIT_EXCEEDED");
  }
  return {
    allowed: true,
    projected_qty_on_hand: projectedQtyOnHand,
    code: "ALLOWED",
  };
}
