export type CommandeStockScope = "OLD" | "NEW";

export type CommandeStockAvailability = {
  OLD: number;
  NEW: number;
};

export type CommandeStockDemandLine = {
  article_id: string | null;
  /** Article + version key for version-scoped orders; falls back to article_id for legacy lines. */
  stock_key?: string | null;
  requested_qty: number;
};

export type CommandeStockScopeAllocation = {
  old_available_qty: number;
  old_used_qty: number;
  new_available_qty: number;
  new_used_qty: number;
  available_qty: number;
  available_used_qty: number;
  shortage_qty: number;
  proposed_production_qty: number;
  status: "FULL" | "PARTIAL" | "NONE";
};

function finiteNonNegative(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.max(0, numberValue) : 0;
}

/**
 * Allocates the same business article across the two functional stock scopes.
 * OLD is intentionally consumed first; repeated order lines share the remaining
 * quantity so the preview cannot count the same physical stock twice.
 */
export function allocateCommandeStockOldThenNew(
  lines: CommandeStockDemandLine[],
  availabilityByArticle: ReadonlyMap<string, CommandeStockAvailability>
): CommandeStockScopeAllocation[] {
  const remainingByArticle = new Map<string, CommandeStockAvailability>();

  return lines.map((line) => {
    const requestedQty = finiteNonNegative(line.requested_qty);
    const articleId = line.article_id;
    const stockKey = line.stock_key ?? articleId;
    const configured = stockKey ? availabilityByArticle.get(stockKey) : undefined;
    const initial = {
      OLD: finiteNonNegative(configured?.OLD),
      NEW: finiteNonNegative(configured?.NEW),
    };
    const remaining = stockKey
      ? remainingByArticle.get(stockKey) ?? { ...initial }
      : { OLD: 0, NEW: 0 };

    const oldAvailable = finiteNonNegative(remaining.OLD);
    const oldUsed = Math.min(requestedQty, oldAvailable);
    const afterOld = Math.max(0, requestedQty - oldUsed);
    const newAvailable = finiteNonNegative(remaining.NEW);
    const newUsed = Math.min(afterOld, newAvailable);
    const availableUsed = oldUsed + newUsed;
    const shortage = Math.max(0, requestedQty - availableUsed);

    if (stockKey) {
      remainingByArticle.set(stockKey, {
        OLD: Math.max(0, oldAvailable - oldUsed),
        NEW: Math.max(0, newAvailable - newUsed),
      });
    }

    return {
      old_available_qty: oldAvailable,
      old_used_qty: oldUsed,
      new_available_qty: newAvailable,
      new_used_qty: newUsed,
      available_qty: oldAvailable + newAvailable,
      available_used_qty: availableUsed,
      shortage_qty: shortage,
      proposed_production_qty: shortage,
      status: shortage === 0 ? "FULL" : availableUsed === 0 ? "NONE" : "PARTIAL",
    };
  });
}
