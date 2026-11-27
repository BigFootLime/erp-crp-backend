import type { PoolClient } from "pg";
import type { MaterialBarBatch } from "./material-bar-inventory.repository";

/** Allocate once for the receipt, across every location of the same lot. */
export async function allocateReceivedBarCodesTx(
  tx: Pick<PoolClient, "query">,
  batch: Pick<MaterialBarBatch, "lotId" | "lotCode">,
  count: number,
): Promise<readonly string[]> {
  if (!/^MP-[0-9]{4,}$/.test(batch.lotCode) || count === 0) return [];

  const { rows: [counter] } = await tx.query<{ last_number: string }>(`
    INSERT INTO public.stock_received_bar_counters (lot_id, last_number)
    VALUES ($1::uuid, $2::bigint)
    ON CONFLICT (lot_id) DO UPDATE
      SET last_number = stock_received_bar_counters.last_number + excluded.last_number
    RETURNING last_number::text
  `, [batch.lotId, count]);
  const first = BigInt(counter.last_number) - BigInt(count) + 1n;
  return Array.from({ length: count }, (_, index) => `${batch.lotCode}-${first + BigInt(index)}`);
}
