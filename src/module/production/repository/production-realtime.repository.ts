import type { PoolClient } from "pg";

import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";

type DbQueryer = Pick<PoolClient, "query">;

export type ProductionRealtimeAction = "created" | "updated" | "deleted" | "status_changed";

export function productionRealtimeActionFromAudit(action: string): ProductionRealtimeAction {
  const normalized = action.toLowerCase();
  if (normalized.endsWith(".create") || normalized.endsWith(".generate")) return "created";
  if (normalized.includes("delete") || normalized.includes("archive")) return "deleted";
  if (normalized.includes("receipt") || normalized.includes("status") || normalized.includes("transition")) {
    return "status_changed";
  }
  return "updated";
}

export async function enqueueProductionOfChanged(
  tx: DbQueryer,
  params: {
    ofId: string | number;
    auditId: string;
    action: ProductionRealtimeAction;
    occurredAt: string;
  }
): Promise<void> {
  const entityId = String(params.ofId);
  await enqueueEntityChanged(tx, {
    entityType: "OF",
    entityId,
    action: params.action,
    module: "production",
    at: params.occurredAt,
    invalidateKeys: [
      "production:ofs",
      `production:of:${entityId}`,
      `production:of:${entityId}:receipt-context`,
      `production:of:${entityId}:traceability`,
    ],
  }, { deduplicationKey: `production-audit:${params.auditId}:of:${entityId}` });
}
