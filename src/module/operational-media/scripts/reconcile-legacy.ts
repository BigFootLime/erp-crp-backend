import { reconcileLegacyOperationalMedia } from "../services/operational-media-reconciliation.service";
import pool from "../../../config/database";
import logger from "../../../utils/logger";

async function main() {
  const rawBatchSize = process.env.CERP_OPERATIONAL_MEDIA_RECONCILE_BATCH_SIZE;
  const batchSize = rawBatchSize === undefined ? undefined : Number(rawBatchSize);
  const result = await reconcileLegacyOperationalMedia({ batchSize });
  // Aggregate-only output: physical paths and scanner details stay out of CLI logs.
  process.stdout.write(`${JSON.stringify({ operation: "operational_media_legacy_reconcile", ...result })}\n`);
}

void main()
  .catch((error: unknown) => {
    logger.error("operational_media_reconciliation_failed", {
      failure_type: error instanceof Error ? error.name : "UnknownError",
      failure_code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : null,
    });
    process.stderr.write("operational-media reconciliation failed; consult protected service logs\n");
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
