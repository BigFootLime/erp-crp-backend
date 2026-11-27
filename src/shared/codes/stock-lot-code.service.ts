import type { PoolClient } from "pg";
import { generateTransactionalBusinessCode } from "./code-generator.service";

/** The caller inserts the lot in the same transaction as its allocation. */
export async function generateStockLotCode(
  tx: Pick<PoolClient, "query">,
  articleCategory: string | null | undefined,
): Promise<string> {
  const category = articleCategory?.trim().toLowerCase();
  const material = category === "matiere" || category === "matiere_premiere";
  const treatment = category === "traitement";
  if (!material && !treatment) return generateTransactionalBusinessCode(tx, { prefix: "LOT" });

  const { rows: [counter] } = await tx.query<{ value: string }>(material
    ? `UPDATE public.stock_lot_code_counters
       SET last_material_number = last_material_number + 1
       WHERE singleton
       RETURNING last_material_number::text AS value`
    : `UPDATE public.stock_lot_code_counters
       SET last_treatment_number = last_treatment_number + 1
       WHERE singleton
       RETURNING last_treatment_number::text AS value`);

  if (!counter) throw new Error("Stock lot counters are not initialized");
  return `${material ? "MP" : "TR"}-${counter.value.padStart(4, "0")}`;
}
