import type { PoolClient } from "pg"
import pool from "../../../config/database"

/** All preparation/stock/payment evidence in one read snapshot. No mutation. */
export async function withDeliveryReadSnapshot<T>(read: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect()
  try {
    await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    const result = await read(tx)
    await tx.query("COMMIT")
    return result
  } catch (error) {
    await tx.query("ROLLBACK")
    throw error
  } finally { tx.release() }
}
