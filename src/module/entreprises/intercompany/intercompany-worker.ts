import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import pool from "../../../config/database";
import { startDrainableRecurringTask } from "../../../shared/runtime/drainable-recurring-task";
import { logger, safeErrorCode } from "../../../shared/observability/logger";
import { parseIntercompanyMessage, type IntercompanyMessage } from "./intercompany-message";
import { deliverIntercompanyMessage, intercompanyTransportConfiguration, type IntercompanyTransportConfiguration } from "./intercompany-transport";

/** One lease at a time, bounded I/O and durable retries; receiver owns deduplication. */
export async function runIntercompanyOutboxBatch(db: Pool, config: IntercompanyTransportConfiguration, options: {
  limit?: number; shouldContinue?: () => boolean;
  deliver?: (config: IntercompanyTransportConfiguration, message: IntercompanyMessage) => Promise<void>;
} = {}): Promise<{ delivered: number; failed: number }> {
  const totals = { delivered: 0, failed: 0 };
  if (!config.enabled) return totals;
  const limit = Math.min(10, Math.max(1, options.limit ?? 5));
  for (let index = 0; index < limit && (options.shouldContinue?.() ?? true); index++) {
    const leaseOwner = randomUUID();
    const claimed = await db.query<{ id: string; message: unknown; attempts: number }>(
      `WITH next_message AS (
        SELECT id FROM public.cerp_intercompany_outbox WHERE source_company_id=$1::uuid AND environment=$2
          AND delivered_at IS NULL AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now())
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE public.cerp_intercompany_outbox outbox SET lease_owner=$3::uuid,lease_until=now()+interval '30 seconds',attempts=attempts+1
        FROM next_message WHERE outbox.id=next_message.id RETURNING outbox.id::text,outbox.message,outbox.attempts`,
      [config.company_id, config.environment, leaseOwner]);
    const row = claimed.rows[0]; if (!row) break;
    try {
      const message = parseIntercompanyMessage(row.message);
      await (options.deliver ?? deliverIntercompanyMessage)(config, message);
      await db.query(`UPDATE public.cerp_intercompany_outbox SET delivered_at=now(),lease_owner=NULL,lease_until=NULL,last_error_code=NULL
        WHERE id=$1::uuid AND lease_owner=$2::uuid AND delivered_at IS NULL`, [row.id, leaseOwner]);
      totals.delivered++;
    } catch (error) {
      const code = safeErrorCode(error);
      const delaySeconds = Math.min(3600, 5 * (2 ** Math.min(row.attempts, 10)));
      await db.query(`UPDATE public.cerp_intercompany_outbox SET next_attempt_at=now()+($3::integer*interval '1 second'),
        lease_owner=NULL,lease_until=NULL,last_error_code=$4 WHERE id=$1::uuid AND lease_owner=$2::uuid AND delivered_at IS NULL`,
        [row.id, leaseOwner, delaySeconds, code]);
      logger.warn("intercompany_delivery_deferred", { message_id: row.id, attempt: row.attempts, failure_code: code });
      totals.failed++;
    }
  }
  return totals;
}

export function startIntercompanyDeliveryMaintenance(): () => Promise<void> {
  const config = intercompanyTransportConfiguration();
  if (!config.enabled) return async () => undefined;
  let stopped = false;
  const recurring = startDrainableRecurringTask(async () => {
    await runIntercompanyOutboxBatch(pool, config, { shouldContinue: () => !stopped });
  }, 2000, { onError: error => logger.error("intercompany_worker_cycle_failed", { failure_code: safeErrorCode(error) }) });
  return async () => { stopped = true; await recurring.stop(); };
}
