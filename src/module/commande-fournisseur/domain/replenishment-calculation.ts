export type ReplenishmentCalculationInput = {
  qty_on_hand: number
  qty_reserved: number
  qty_available: number
  qty_open_orders: number
  minimum_stock_qty: number | null
  safety_stock_qty: number | null
  target_stock_qty: number | null
  reorder_qty: number | null
  stock_unit: string | null
  purchase_unit: string | null
  stock_units_per_purchase_unit: number | null
  supplier_moq: number | null
  purchase_lot_size: number | null
  unit_price: number | null
}

export type ReplenishmentCalculation = {
  reason_code: "RUPTURE" | "SOUS_MINIMUM" | "COUVERT" | "SEUIL_MANQUANT"
  target_stock_qty: number
  gross_requirement_qty: number
  net_requirement_qty: number
  proposed_purchase_qty: number | null
  proposed_stock_qty: number | null
  stock_units_per_purchase_unit: number | null
  estimated_total: number | null
  missing_data: string[]
  warnings: string[]
  formula: string
}

const EPS = 1e-9

export function normalizeUnit(value: string | null | undefined): string | null {
  const unit = value?.trim().toLowerCase()
  if (!unit) return null
  if (["pce", "pcs", "pc", "piece", "pièce"].includes(unit)) return "u"
  return unit
}

function nonNegative(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0
}

export function roundQty(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function ceilToLot(value: number, lot: number | null): number {
  if (!lot || lot <= 0) return roundQty(value)
  return roundQty(Math.ceil((value - EPS) / lot) * lot)
}

export function calculateReplenishment(input: ReplenishmentCalculationInput): ReplenishmentCalculation {
  const missing = new Set<string>()
  const warnings = new Set<string>()
  const available = nonNegative(input.qty_available)
  const openOrders = nonNegative(input.qty_open_orders)
  const minimum = input.minimum_stock_qty == null ? null : nonNegative(input.minimum_stock_qty)
  const safety = input.safety_stock_qty == null ? 0 : nonNegative(input.safety_stock_qty)

  if (minimum == null || minimum <= 0) missing.add("MINIMUM_STOCK")
  if (input.safety_stock_qty == null) warnings.add("SAFETY_STOCK_MISSING")
  if (!normalizeUnit(input.stock_unit)) missing.add("STOCK_UNIT")

  const target = input.target_stock_qty != null
    ? nonNegative(input.target_stock_qty)
    : nonNegative(minimum) + safety
  const gross = roundQty(Math.max(0, target - available))
  const net = roundQty(Math.max(0, target - available - openOrders))
  const reason = minimum == null || minimum <= 0
    ? "SEUIL_MANQUANT"
    : net <= EPS
      ? "COUVERT"
      : available <= EPS
        ? "RUPTURE"
        : "SOUS_MINIMUM"

  const stockUnit = normalizeUnit(input.stock_unit)
  const purchaseUnit = normalizeUnit(input.purchase_unit)
  let coefficient: number | null = null
  if (!purchaseUnit) {
    missing.add("PURCHASE_UNIT")
  } else if (stockUnit === purchaseUnit) {
    coefficient = 1
  } else if (input.stock_units_per_purchase_unit && input.stock_units_per_purchase_unit > 0) {
    coefficient = input.stock_units_per_purchase_unit
  } else {
    missing.add("UNIT_CONVERSION")
  }

  let purchaseQty: number | null = null
  let stockQty: number | null = null
  if (net > EPS && coefficient) {
    const baseStockNeed = Math.max(net, nonNegative(input.reorder_qty))
    const rawPurchase = baseStockNeed / coefficient
    const moqApplied = Math.max(rawPurchase, nonNegative(input.supplier_moq))
    purchaseQty = ceilToLot(moqApplied, input.purchase_lot_size)
    stockQty = roundQty(purchaseQty * coefficient)
    if (input.supplier_moq && purchaseQty > rawPurchase + EPS) warnings.add("MOQ_APPLIED")
    if (input.purchase_lot_size && purchaseQty > moqApplied + EPS) warnings.add("PURCHASE_LOT_ROUNDED")
    if (stockQty > net + EPS) warnings.add("OVERAGE_AFTER_ROUNDING")
  }
  if (input.unit_price == null) warnings.add("PRICE_MISSING")

  return {
    reason_code: reason,
    target_stock_qty: roundQty(target),
    gross_requirement_qty: gross,
    net_requirement_qty: net,
    proposed_purchase_qty: purchaseQty,
    proposed_stock_qty: stockQty,
    stock_units_per_purchase_unit: coefficient,
    estimated_total: purchaseQty != null && input.unit_price != null
      ? roundMoney(purchaseQty * nonNegative(input.unit_price))
      : null,
    missing_data: [...missing].sort(),
    warnings: [...warnings].sort(),
    formula: "max(0, cible - disponible - commandes_ouvertes); puis MOQ et arrondi au lot d'achat",
  }
}
