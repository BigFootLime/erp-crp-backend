import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";

/** Hold the same control lock as the canonical writer until this transaction ends. */
export async function lockLegacyControlForWrite(db: Pick<PoolClient, "query">, id: string): Promise<boolean> {
  const { rows } = await db.query<{ plan_id: string | null; plan_snapshot_sha256: string | null }>(
    `SELECT plan_id, plan_snapshot_sha256 FROM quality_control WHERE id = $1::uuid FOR UPDATE`,
    [id]
  );
  const control = rows[0];
  if (!control) return false;
  // Either marker is sufficient, including incomplete/corrupted plan metadata.
  if (control.plan_id !== null || control.plan_snapshot_sha256 !== null) {
    throw new HttpError(
      409,
      "QUALITY_CANONICAL_EXECUTION_REQUIRED",
      "Ce contrôle utilise un plan figé. Ouvrez son poste Qualité pour saisir les mesures et prononcer la décision."
    );
  }
  return true;
}
