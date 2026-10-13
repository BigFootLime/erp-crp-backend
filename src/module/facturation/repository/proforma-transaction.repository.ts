import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { financeRequestHash, normalizeIdempotencyKey } from "../domain/finance-policy";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { acquireFinanceIdempotency, insertFinanceEvent, insertGlobalFinanceAudit, newCorrelationId, saveFinanceReceipt,
  type FinanceActorContext } from "./workflow.repository.shared";

type CommandEvidence<T> = { aggregateId: string; result: T; oldValues?: unknown; newValues?: unknown; deliveryAllocationIds: number[] };
export async function runProformaCommand<T extends Record<string, unknown>>(args: {
  actor: FinanceActorContext; idempotencyKey: string | undefined; commandType: string; payload: unknown;
  work: (tx: PoolClient, correlationId: string) => Promise<CommandEvidence<T>>;
}): Promise<T & { correlation_id: string; idempotent_replay: boolean }> {
  const key = normalizeIdempotencyKey(args.idempotencyKey);
  const requestHash = financeRequestHash(args.commandType, args.payload);
  let tx: PoolClient;
  try { tx = await pool.connect(); } catch { throw new HttpError(503, "PROFORMA_DATABASE_UNAVAILABLE", "L'ERP est temporairement indisponible : réessayez la même action."); }
  try { return await withRealtimeOutboxTransaction(tx, async client => {
    const receipt = await acquireFinanceIdempotency({ client, actor: args.actor, idempotencyKeyRaw: key,
      commandType: args.commandType, requestPayload: args.payload });
    if (receipt.replay) return { ...receipt.replay, idempotent_replay: true } as T & { correlation_id: string; idempotent_replay: boolean };
    // The command source reader locks orders before the contract binding lock,
    // matching the explicit legacy association writer's ordering.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('delivery-prepayment-binding',0))");
    const correlationId = newCorrelationId();
    const evidence = await args.work(client, correlationId);
    const result = { ...evidence.result, correlation_id: correlationId, idempotent_replay: false };
    await insertFinanceEvent({ client, aggregateType: "PROFORMA", aggregateId: evidence.aggregateId,
      eventType: args.commandType, actor: args.actor, correlationId, idempotencyKey: key,
      oldValues: evidence.oldValues, newValues: evidence.newValues ?? evidence.result });
    await insertGlobalFinanceAudit({ client, actor: args.actor, action: `facturation.${args.commandType.toLowerCase()}`,
      entityType: "proforma", entityId: evidence.aggregateId,
      details: { command_type: args.commandType, correlation_id: correlationId } });
    const at = new Date().toISOString();
    await enqueueEntityChanged(client, { entityType: args.commandType === "PROFORMA_AFFAIR_TERMS_DECIDED" ? "PROFORMA_AFFAIR" : "PROFORMA",
      entityId: evidence.aggregateId, action: "updated", module: "facturation", at, invalidateKeys: ["proformas"] },
      { deduplicationKey: `proforma:${correlationId}:facturation` });
    for (const allocationId of [...new Set(evidence.deliveryAllocationIds)].sort((a,b)=>a-b)) {
      await enqueueEntityChanged(client, { entityType: "DELIVERY_PREPAYMENT", entityId: String(allocationId), action: "updated",
        module: "livraisons", at, invalidateKeys: ["livraisons", "delivery-affairs"] },
        { deduplicationKey: `proforma:${correlationId}:affair:${allocationId}` });
    }
    await saveFinanceReceipt({ client, actor: args.actor, idempotencyKey: key, requestHash, commandType: args.commandType,
      aggregateType: "PROFORMA", aggregateId: evidence.aggregateId, requestPayload: args.payload, resultPayload: result, correlationId });
    return result;
  }, { reconcileCommit: async verifier => {
    const receipt = await verifier.query<{ request_hash: string }>(
      "SELECT request_hash FROM public.finance_command_receipts WHERE actor_user_id=$1 AND idempotency_key=$2",
      [args.actor.userId, key]);
    return receipt.rows[0]?.request_hash === requestHash ? "committed" : receipt.rows.length ? "unknown" : "not_committed";
  } }); } catch (error) {
    if (error instanceof HttpError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (["23505", "23503", "23514", "55000"].includes(code)) throw new HttpError(409, "PROFORMA_CONCURRENT_CHANGE", "Les données de préparation ont changé : actualisez l'aperçu avant de continuer.");
    if (["40P01", "55P03", "57014", "ECONNRESET", "ECONNREFUSED"].includes(code)) throw new HttpError(503, "PROFORMA_RETRY_REQUIRED", "L'enregistrement n'est pas confirmé : réessayez la même action.");
    throw error;
  }
}
