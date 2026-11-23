import { z } from "zod";

const snapshotSchema = z.object({
  source_customer_stock_quantity: z.number().min(0).max(1e9),
  source_unit: z.string().min(1).optional(),
  source_quantity: z.number().min(0).optional(),
  source_as_of: z.string().datetime({ offset: true }),
});

export function customerStockFromSnapshot(snapshot: unknown, fallbackUnit: unknown) {
  const result = snapshotSchema.safeParse(snapshot);
  if (!result.success) return undefined;
  const unit = result.data.source_unit ?? fallbackUnit;
  if (typeof unit !== "string" || !unit) return undefined;
  return {
    quantity: result.data.source_customer_stock_quantity,
    unit,
    as_of: result.data.source_as_of,
  };
}

/** Compare quantities in the original customer unit, before the article mapping. */
export function customerStockCanCoverRequestedQuantity(snapshot: unknown): boolean {
  const result = snapshotSchema.safeParse(snapshot);
  if (!result.success) return false;
  const { source_quantity, source_unit, source_customer_stock_quantity } = result.data;
  return Boolean(source_unit && source_quantity && source_customer_stock_quantity >= source_quantity);
}
