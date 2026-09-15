import type { PoolClient } from "pg";
type Db = Pick<PoolClient, "query">;
export async function receiptTransferInstalled(tx: Db) {
  return (
    (
      await tx.query(
        "SELECT to_regprocedure('public.subcontract_receipt_transferred_968(uuid)') IS NOT NULL AS installed",
      )
    ).rows[0]?.installed === true
  );
}
export async function receiptTransferred(
  tx: Db,
  lineId: string,
): Promise<number> {
  if (!(await receiptTransferInstalled(tx))) return 0;
  return Number(
    (
      await tx.query(
        "SELECT public.subcontract_receipt_transferred_968($1::uuid) AS qty",
        [lineId],
      )
    ).rows[0].qty,
  );
}
