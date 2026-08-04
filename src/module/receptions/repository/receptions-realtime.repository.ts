import type { PoolClient } from "pg";

import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";

type DbQueryer = Pick<PoolClient, "query">;

export type ReceptionRealtimeAction = "created" | "updated" | "deleted" | "status_changed";

export function receptionRealtimeActionFromAudit(action: string): ReceptionRealtimeAction {
  const normalized = action.toLowerCase();
  if (normalized === "receptions.create") return "created";
  if (normalized.includes("decide") || normalized.includes("status") || normalized.includes("transition")) {
    return "status_changed";
  }
  return "updated";
}

export async function enqueueReceptionChanged(
  tx: DbQueryer,
  params: {
    receptionId: string;
    auditId: string;
    action: ReceptionRealtimeAction;
    occurredAt: string;
  }
): Promise<void> {
  await enqueueEntityChanged(tx, {
    entityType: "RECEPTION",
    entityId: params.receptionId,
    action: params.action,
    module: "receptions",
    at: params.occurredAt,
    invalidateKeys: ["receptions:list", "receptions:kpis", `receptions:detail:${params.receptionId}`],
  }, { deduplicationKey: `reception-audit:${params.auditId}` });
}
