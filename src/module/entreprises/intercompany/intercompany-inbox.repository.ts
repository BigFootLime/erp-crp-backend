import type { Pool, PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import type { IntercompanyMessage, IntercompanyMessageHandler, IntercompanyMessageKind } from "./intercompany-message";

export type IntercompanyDeliveryReceipt = { id: string; payload_sha256: string; status: "PROCESSED" | "REPLAY" };
export type IntercompanyHandlers = Partial<Record<IntercompanyMessageKind, IntercompanyMessageHandler>>;

/** Inbox receipt and all native business writes commit together. */
export async function receiveIntercompanyMessage(db: Pool, message: IntercompanyMessage, handlers: IntercompanyHandlers): Promise<IntercompanyDeliveryReceipt> {
  const handler = handlers[message.kind];
  if (!handler) throw new HttpError(409, "INTERCOMPANY_MESSAGE_KIND_UNAVAILABLE", "Ce type d'échange n'est pas encore activé.");
  return withRealtimeOutboxTransaction(await db.connect(), async tx => {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO public.cerp_intercompany_inbox(id,source_company_id,destination_company_id,environment,kind,aggregate_id,revision,payload_sha256,payload)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT DO NOTHING RETURNING id::text`,
      [message.id, message.source_company_id, message.destination_company_id, message.environment,
        message.kind, message.aggregate_id, message.revision, message.payload_sha256, JSON.stringify(message.payload)],
    );
    if (!inserted.rows[0]) {
      const prior = await tx.query<{ id: string; source_company_id: string; destination_company_id: string; environment: string; kind: string; aggregate_id: string; revision: number; payload_sha256: string; processed_at: unknown }>(
        `SELECT id::text,source_company_id::text,destination_company_id::text,environment,kind,aggregate_id,revision,payload_sha256,processed_at
         FROM public.cerp_intercompany_inbox WHERE id=$1::uuid OR
          (source_company_id=$2::uuid AND destination_company_id=$3::uuid AND environment=$4 AND kind=$5 AND aggregate_id=$6 AND revision=$7) FOR UPDATE`,
        [message.id, message.source_company_id, message.destination_company_id, message.environment, message.kind, message.aggregate_id, message.revision],
      );
      const row = prior.rows[0];
      if (prior.rows.length !== 1 || !row || row.id !== message.id || row.source_company_id !== message.source_company_id ||
        row.destination_company_id !== message.destination_company_id || row.environment !== message.environment || row.kind !== message.kind ||
        row.aggregate_id !== message.aggregate_id || row.revision !== message.revision || row.payload_sha256 !== message.payload_sha256)
        throw new HttpError(409, "INTERCOMPANY_MESSAGE_REPLAY_CONFLICT", "Un reçu différent existe pour cet échange.");
      if (row.processed_at) return { id: message.id, payload_sha256: message.payload_sha256, status: "REPLAY" as const };
    }
    await handler(tx, message);
    await tx.query("UPDATE public.cerp_intercompany_inbox SET processed_at=now() WHERE id=$1::uuid", [message.id]);
    return { id: message.id, payload_sha256: message.payload_sha256, status: "PROCESSED" as const };
  }, { reconcileCommit: async (verifier: PoolClient) => {
    const found = await verifier.query<{ payload_sha256: string; processed_at: unknown }>(
      "SELECT payload_sha256,processed_at FROM public.cerp_intercompany_inbox WHERE id=$1::uuid", [message.id]);
    return found.rows[0]?.payload_sha256 === message.payload_sha256 && found.rows[0]?.processed_at ? "committed" : "unknown";
  } });
}
