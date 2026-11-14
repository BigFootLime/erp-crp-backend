import type { PoolClient } from "pg"

import pool from "../../../config/database"
import { HttpError } from "../../../utils/httpError"
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"
import type { BonLivraisonStatut } from "../types/livraisons.types"
import { insertEvent } from "./delivery-events.repository"

export type LivraisonPrintStatus = {
  bon_livraison_id: string
  printing_status: "PENDING" | "PUBLISHED" | "NOT_REQUESTED"
  print_retry_available: boolean
  outbox_id: string | null
  attempts: number
  last_requested_at: string | null
}

/** Read-only status for the external print effect; shipment state is separate. */
export async function repoGetLivraisonPrintStatus(bonLivraisonId: string): Promise<LivraisonPrintStatus | null> {
  const bl = await pool.query<{ id: string }>(`SELECT id::text AS id FROM public.bon_livraison WHERE id = $1::uuid`, [bonLivraisonId])
  if (!bl.rows[0]) return null
  const outbox = await pool.query<{
    id: string
    published_at: string | null
    attempts: number
    requested_at: string
  }>(
    `
      SELECT id::text AS id, published_at::text AS published_at, attempts, requested_at::text AS requested_at
      FROM public.delivery_outbox
      WHERE aggregate_id = $1::uuid
        AND event_type = 'DELIVERY.PRINT_REQUESTED'
      ORDER BY requested_at DESC, id DESC
      LIMIT 1
    `,
    [bonLivraisonId]
  )
  const row = outbox.rows[0] ?? null
  if (!row) {
    return {
      bon_livraison_id: bonLivraisonId,
      printing_status: "NOT_REQUESTED",
      print_retry_available: false,
      outbox_id: null,
      attempts: 0,
      last_requested_at: null,
    }
  }
  return {
    bon_livraison_id: bonLivraisonId,
    printing_status: row.published_at ? "PUBLISHED" : "PENDING",
    print_retry_available: !row.published_at,
    outbox_id: row.id,
    attempts: Number(row.attempts ?? 0),
    last_requested_at: row.requested_at,
  }
}

/**
 * Requeue only the print side effect.  No reservation, allocation, BL status
 * or stock movement is touched, so retrying this endpoint can never issue
 * stock twice.
 */
export async function repoRetryLivraisonPrint(params: {
  bon_livraison_id: string
  user_id: number
}): Promise<LivraisonPrintStatus> {
  const db = await pool.connect()
  try {
    await db.query("BEGIN")
    const header = await db.query<{ statut: BonLivraisonStatut }>(
      `SELECT statut FROM public.bon_livraison WHERE id = $1::uuid FOR UPDATE`,
      [params.bon_livraison_id]
    )
    const bl = header.rows[0] ?? null
    if (!bl) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
    if (bl.statut !== "SHIPPED" && bl.statut !== "DELIVERED") {
      throw new HttpError(409, "PRINT_NOT_AVAILABLE", "Printing can be retried only after BL validation")
    }
    const existing = await db.query<{ id: string; published_at: string | null }>(
      `
        SELECT id::text AS id, published_at::text AS published_at
        FROM public.delivery_outbox
        WHERE event_type = 'DELIVERY.PRINT_REQUESTED' AND aggregate_id = $1::uuid
        FOR UPDATE
      `,
      [params.bon_livraison_id]
    )
    const current = existing.rows[0] ?? null
    if (current?.published_at) {
      throw new HttpError(409, "PRINT_ALREADY_PUBLISHED", "The print request was already published")
    }
    const payload = JSON.stringify({
      bon_livraison_id: params.bon_livraison_id,
      printing_status: "PENDING",
      requested_at: new Date().toISOString(),
      trigger: "MANUAL_RETRY",
    })
    let queued: { id: string; requested_at: string } | null = null
    if (current) {
      const updated = await db.query<{ id: string; requested_at: string }>(
        `
          UPDATE public.delivery_outbox
          SET payload = $2::jsonb, published_at = NULL, attempts = 0, requested_at = now()
          WHERE id = $1::uuid
          RETURNING id::text AS id, requested_at::text AS requested_at
        `,
        [current.id, payload]
      )
      queued = updated.rows[0] ?? null
    } else {
      const inserted = await db.query<{ id: string; requested_at: string }>(
        `
          INSERT INTO public.delivery_outbox (event_type, aggregate_id, payload)
          VALUES ('DELIVERY.PRINT_REQUESTED',$1::uuid,$2::jsonb)
          RETURNING id::text AS id, requested_at::text AS requested_at
        `,
        [params.bon_livraison_id, payload]
      )
      queued = inserted.rows[0] ?? null
    }
    if (!queued) throw new Error("Failed to enqueue delivery print retry")
    await insertEvent(db, {
      bon_livraison_id: params.bon_livraison_id,
      event_type: "PRINT_RETRY_REQUESTED",
      user_id: params.user_id,
      new_values: { printing_status: "PENDING", previous_outbox_id: current?.id ?? null },
    })
    await repoInsertAuditLog({
      user_id: params.user_id,
      body: {
        event_type: "ACTION",
        action: "livraisons.print.retry",
        page_key: "livraisons",
        entity_type: "bon_livraison",
        entity_id: params.bon_livraison_id,
        path: `/api/v1/livraisons/${params.bon_livraison_id}/print/retry`,
        client_session_id: null,
        details: { previous_outbox_id: current?.id ?? null },
      },
      ip: null,
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
      tx: db,
    })
    await db.query("COMMIT")
    return {
      bon_livraison_id: params.bon_livraison_id,
      printing_status: "PENDING",
      print_retry_available: true,
      outbox_id: queued.id,
      attempts: 0,
      last_requested_at: queued.requested_at,
    }
  } catch (err) {
    await db.query("ROLLBACK")
    throw err
  } finally {
    db.release()
  }
}
