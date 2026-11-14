import type { PoolClient } from "pg"

import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service"

export async function insertEvent(
  client: PoolClient,
  params: {
    bon_livraison_id: string
    event_type: string
    user_id: number | null
    old_values?: unknown | null
    new_values?: unknown | null
  }
) {
  const inserted = await client.query<{ id: string; created_at: string }>(
    `
    INSERT INTO bon_livraison_event_log (bon_livraison_id, event_type, old_values, new_values, user_id)
    VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5)
    RETURNING id::text AS id, created_at::text AS created_at
    `,
    [
      params.bon_livraison_id,
      params.event_type,
      params.old_values === undefined ? null : JSON.stringify(params.old_values),
      params.new_values === undefined ? null : JSON.stringify(params.new_values),
      params.user_id,
    ]
  )
  const event = inserted.rows[0]
  if (!event) throw new Error("Failed to persist livraison event")
  await enqueueEntityChanged(client, {
    entityType: "BON_LIVRAISON",
    entityId: params.bon_livraison_id,
    action: params.event_type === "CREATED"
      ? "created"
      : params.event_type.includes("STATUS") || params.event_type.includes("SHIPMENT")
        ? "status_changed"
        : "updated",
    module: "livraisons",
    at: event.created_at,
    invalidateKeys: ["livraisons:list", `livraisons:detail:${params.bon_livraison_id}`],
  }, { deduplicationKey: `livraison-event:${event.id}` })
}
