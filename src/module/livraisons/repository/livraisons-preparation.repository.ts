import crypto from "node:crypto"
import type { PoolClient } from "pg"

import pool from "../../../config/database"
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction"
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service"
import { HttpError } from "../../../utils/httpError"
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"
import { hashStockCommand, normalizeIdempotencyKey } from "../../stock/domain/stock-command"
import {
  deriveLivraisonPreparationState,
  matchesLivraisonPickScanCode,
} from "../domain/livraisons-preparation"
import type {
  BonLivraisonPreparation,
  BonLivraisonStatut,
  LivraisonPreparationTask,
  UserLite,
} from "../types/livraisons.types"
import type {
  ConfirmLivraisonPreparationBodyDTO,
  ResetLivraisonPreparationBodyDTO,
} from "../validators/livraisons.validators"

type Queryable = Pick<PoolClient, "query">

type PreparationHeaderRow = {
  id: string
  numero: string
  statut: BonLivraisonStatut
  row_version: number
}

type PreparationTaskRow = {
  allocation_id: string
  line_id: string
  line_order: number
  designation: string
  code_piece: string | null
  article_id: string
  article_code: string | null
  article_designation: string | null
  lot_id: string | null
  lot_code: string | null
  lot_status: string | null
  stock_trace_code: string | null
  qr_payload: string | null
  magasin_code: string | null
  emplacement_code: string | null
  location_id: string | null
  stock_level_id: string | null
  reservation_status: string | null
  stock_movement_line_id: string | null
  quantity: number
  unit: string | null
  affaire_refs: string[] | null
  mp_lot_refs: string[] | null
  traitement_lot_refs: string[] | null
  latest_event_id: string | null
  latest_event_type: string | null
  latest_event_values: Record<string, unknown> | null
  latest_event_created_at: string | null
  confirmed_by_id: number | null
  confirmed_by_username: string | null
  confirmed_by_name: string | null
  confirmed_by_surname: string | null
}

function toUser(row: PreparationTaskRow): UserLite | null {
  if (row.confirmed_by_id === null || !row.confirmed_by_username) return null
  const label = [row.confirmed_by_name, row.confirmed_by_surname]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(" ") || row.confirmed_by_username
  return {
    id: row.confirmed_by_id,
    username: row.confirmed_by_username,
    name: row.confirmed_by_name,
    surname: row.confirmed_by_surname,
    label,
  }
}

function isTaskOperational(row: PreparationTaskRow): boolean {
  return Boolean(
    row.location_id &&
      row.stock_level_id &&
      row.reservation_status === "ACTIVE" &&
      !row.stock_movement_line_id &&
      (!row.lot_id || row.lot_status === "LIBERE")
  )
}

export async function repoGetLivraisonPreparation(
  bonLivraisonId: string,
  queryable: Queryable = pool
): Promise<BonLivraisonPreparation | null> {
  const headerResult = await queryable.query<PreparationHeaderRow>(
    `
      SELECT
        id::text AS id,
        numero,
        statut,
        row_version::int AS row_version
      FROM public.bon_livraison
      WHERE id = $1::uuid
    `,
    [bonLivraisonId]
  )
  const header = headerResult.rows[0] ?? null
  if (!header) return null

  const taskResult = await queryable.query<PreparationTaskRow>(
    `
      SELECT
        allocation.id::text AS allocation_id,
        line.id::text AS line_id,
        line.ordre::int AS line_order,
        line.designation,
        line.code_piece,
        allocation.article_id::text AS article_id,
        article.code AS article_code,
        article.designation AS article_designation,
        allocation.lot_id::text AS lot_id,
        lot.lot_code,
        lot.lot_status,
        lot.stock_trace_code::text AS stock_trace_code,
        lot.qr_payload,
        COALESCE(magasin.code, magasin.code_magasin)::text AS magasin_code,
        emplacement.code AS emplacement_code,
        allocation.location_id::text AS location_id,
        allocation.stock_level_id::text AS stock_level_id,
        reservation.status AS reservation_status,
        allocation.stock_movement_line_id::text AS stock_movement_line_id,
        allocation.quantite::float8 AS quantity,
        allocation.unite AS unit,
        ARRAY(
          SELECT DISTINCT ref_value
          FROM (
            SELECT affaire.reference::text AS ref_value
            WHERE affaire.reference IS NOT NULL
            UNION ALL
            SELECT trace.reference_value
            FROM public.stock_lot_trace_references trace
            WHERE trace.lot_id = allocation.lot_id
              AND trace.reference_type IN ('AFFAIRE', 'OF')
          ) refs
          WHERE ref_value IS NOT NULL AND btrim(ref_value) <> ''
          ORDER BY ref_value
        ) AS affaire_refs,
        ARRAY(
          SELECT DISTINCT trace.reference_value
          FROM public.stock_lot_trace_references trace
          WHERE trace.lot_id = allocation.lot_id
            AND trace.reference_type = 'MP_LOT'
          ORDER BY trace.reference_value
        ) AS mp_lot_refs,
        ARRAY(
          SELECT DISTINCT trace.reference_value
          FROM public.stock_lot_trace_references trace
          WHERE trace.lot_id = allocation.lot_id
            AND trace.reference_type = 'TRAITEMENT_LOT'
          ORDER BY trace.reference_value
        ) AS traitement_lot_refs,
        latest_event.id::text AS latest_event_id,
        latest_event.event_type AS latest_event_type,
        latest_event.new_values AS latest_event_values,
        latest_event.created_at::text AS latest_event_created_at,
        actor.id AS confirmed_by_id,
        actor.username AS confirmed_by_username,
        actor.name AS confirmed_by_name,
        actor.surname AS confirmed_by_surname
      FROM public.bon_livraison_ligne_allocations allocation
      JOIN public.bon_livraison_ligne line
        ON line.id = allocation.bon_livraison_ligne_id
      JOIN public.bon_livraison delivery
        ON delivery.id = line.bon_livraison_id
      LEFT JOIN public.articles article ON article.id = allocation.article_id
      LEFT JOIN public.lots lot ON lot.id = allocation.lot_id
      LEFT JOIN public.magasins magasin ON magasin.id = allocation.magasin_id
      LEFT JOIN public.emplacements emplacement ON emplacement.id = allocation.emplacement_id
      LEFT JOIN public.stock_reservations reservation ON reservation.id = allocation.reservation_id
      LEFT JOIN public.affaire affaire ON affaire.id = delivery.affaire_id
      LEFT JOIN LATERAL (
        SELECT event.id, event.event_type, event.new_values, event.created_at, event.user_id
        FROM public.bon_livraison_event_log event
        WHERE event.bon_livraison_id = delivery.id
          AND event.event_type IN ('PICK_CONFIRMED', 'PICK_RESET')
          AND event.new_values->>'allocation_id' = allocation.id::text
        ORDER BY event.created_at DESC, event.id DESC
        LIMIT 1
      ) latest_event ON TRUE
      LEFT JOIN public.users actor ON actor.id = latest_event.user_id
      WHERE delivery.id = $1::uuid
      ORDER BY line.ordre, allocation.created_at, allocation.id
    `,
    [bonLivraisonId]
  )

  const tasks: LivraisonPreparationTask[] = taskResult.rows.map((row) => {
    const confirmed = row.latest_event_type === "PICK_CONFIRMED"
    const inputMethod = row.latest_event_values?.input_method === "SCANNER" ? "SCANNER" : "MANUAL"
    return {
      allocation_id: row.allocation_id,
      line_id: row.line_id,
      line_order: row.line_order,
      designation: row.designation,
      code_piece: row.code_piece,
      article_id: row.article_id,
      article_code: row.article_code,
      article_designation: row.article_designation,
      lot_id: row.lot_id,
      lot_code: row.lot_code,
      lot_status: row.lot_status,
      stock_trace_code: row.stock_trace_code,
      magasin_code: row.magasin_code,
      emplacement_code: row.emplacement_code,
      quantity: Number(row.quantity),
      unit: row.unit,
      reservation_status: row.reservation_status,
      affaire_refs: row.affaire_refs ?? [],
      mp_lot_refs: row.mp_lot_refs ?? [],
      traitement_lot_refs: row.traitement_lot_refs ?? [],
      confirmation: confirmed && row.latest_event_id && row.latest_event_created_at
        ? {
            event_id: row.latest_event_id,
            input_method: inputMethod,
            confirmed_at: row.latest_event_created_at,
            confirmed_by: toUser(row),
          }
        : null,
      can_confirm: header.statut === "READY" && !confirmed && isTaskOperational(row),
    }
  })
  const confirmed = tasks.filter((task) => task.confirmation !== null).length
  const hasBlockedTask = tasks.some((task) => !task.confirmation && !task.can_confirm)
  const derivedState = deriveLivraisonPreparationState({
    status: header.statut,
    total: tasks.length,
    confirmed,
  })
  const state = hasBlockedTask && header.statut === "READY" ? "BLOCKED" : derivedState

  return {
    bon_livraison_id: header.id,
    numero: header.numero,
    status: header.statut,
    row_version: header.row_version,
    state,
    can_ship: header.statut === "READY" && tasks.length > 0 && confirmed === tasks.length,
    progress: {
      total: tasks.length,
      confirmed,
      remaining: Math.max(tasks.length - confirmed, 0),
      percent: tasks.length ? Math.round((confirmed / tasks.length) * 100) : 0,
    },
    tasks,
  }
}

async function findIdempotentEvent(
  client: Queryable,
  userId: number,
  idempotencyKey: string
): Promise<{ request_hash: string } | null> {
  const result = await client.query<{ request_hash: string }>(
    `
      SELECT new_values->>'request_hash' AS request_hash
      FROM public.bon_livraison_event_log
      WHERE user_id = $1
        AND event_type IN ('PICK_CONFIRMED', 'PICK_RESET')
        AND new_values->>'idempotency_key' = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [userId, idempotencyKey]
  )
  return result.rows[0] ?? null
}

async function insertPreparationEvent(
  client: Queryable,
  args: {
    bonLivraisonId: string
    allocationId: string
    eventType: "PICK_CONFIRMED" | "PICK_RESET"
    userId: number
    values: Record<string, unknown>
  }
) {
  const event = await client.query<{ id: string; created_at: string }>(
    `
      INSERT INTO public.bon_livraison_event_log (
        bon_livraison_id, event_type, old_values, new_values, user_id
      )
      VALUES ($1::uuid,$2,NULL,$3::jsonb,$4)
      RETURNING id::text AS id, created_at::text AS created_at
    `,
    [args.bonLivraisonId, args.eventType, JSON.stringify(args.values), args.userId]
  )
  const inserted = event.rows[0]
  if (!inserted) throw new Error("Failed to persist preparation event")
  await enqueueEntityChanged(client, {
    entityType: "BON_LIVRAISON",
    entityId: args.bonLivraisonId,
    action: "updated",
    module: "livraisons",
    at: inserted.created_at,
    invalidateKeys: ["livraisons:list", `livraisons:detail:${args.bonLivraisonId}`],
  }, { deduplicationKey: `livraison-event:${inserted.id}` })
}

async function mutatePreparation(args: {
  bonLivraisonId: string
  allocationId: string
  body: ConfirmLivraisonPreparationBodyDTO | ResetLivraisonPreparationBodyDTO
  userId: number
  idempotencyKeyRaw: string
  mode: "CONFIRM" | "RESET"
}): Promise<BonLivraisonPreparation> {
  const client = await pool.connect()
  await withRealtimeOutboxTransaction(client, async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
    const idempotencyKey = normalizeIdempotencyKey(args.idempotencyKeyRaw)
    const requestPayload = {
      bon_livraison_id: args.bonLivraisonId,
      allocation_id: args.allocationId,
      mode: args.mode,
      ...args.body,
    }
    const requestHash = hashStockCommand("DELIVERY_PICK", requestPayload)
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`delivery-pick:${args.userId}:${idempotencyKey}`]
    )
    const receipt = await findIdempotentEvent(tx, args.userId, idempotencyKey)
    if (receipt && receipt.request_hash !== requestHash) {
      throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette Idempotency-Key a déjà été utilisée pour un autre prélèvement.")
    }
    if (receipt) return

    const headerResult = await tx.query<PreparationHeaderRow>(
      `
        SELECT id::text AS id, numero, statut, row_version::int AS row_version
        FROM public.bon_livraison
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [args.bonLivraisonId]
    )
    const header = headerResult.rows[0] ?? null
    if (!header) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
    if (header.statut !== "READY") {
      throw new HttpError(409, "PREPARATION_NOT_READY", "Le prélèvement physique est autorisé uniquement au statut READY.")
    }
    if (header.row_version !== args.body.expected_version) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Le bon de livraison a changé. Rafraîchissez la préparation.")
    }

    const allocationResult = await tx.query<{
      lot_code: string | null
      stock_trace_code: string | null
      qr_payload: string | null
      lot_id: string | null
      lot_status: string | null
      location_id: string | null
      stock_level_id: string | null
      reservation_status: string | null
      stock_movement_line_id: string | null
      latest_event_type: string | null
    }>(
      `
        SELECT
          lot.lot_code,
          lot.stock_trace_code::text AS stock_trace_code,
          lot.qr_payload,
          allocation.lot_id::text AS lot_id,
          lot.lot_status,
          allocation.location_id::text AS location_id,
          allocation.stock_level_id::text AS stock_level_id,
          reservation.status AS reservation_status,
          allocation.stock_movement_line_id::text AS stock_movement_line_id,
          latest_event.event_type AS latest_event_type
        FROM public.bon_livraison_ligne_allocations allocation
        JOIN public.bon_livraison_ligne line ON line.id = allocation.bon_livraison_ligne_id
        LEFT JOIN public.lots lot ON lot.id = allocation.lot_id
        LEFT JOIN public.stock_reservations reservation ON reservation.id = allocation.reservation_id
        LEFT JOIN LATERAL (
          SELECT event.event_type
          FROM public.bon_livraison_event_log event
          WHERE event.bon_livraison_id = line.bon_livraison_id
            AND event.event_type IN ('PICK_CONFIRMED', 'PICK_RESET')
            AND event.new_values->>'allocation_id' = allocation.id::text
          ORDER BY event.created_at DESC, event.id DESC
          LIMIT 1
        ) latest_event ON TRUE
        WHERE line.bon_livraison_id = $1::uuid
          AND allocation.id = $2::uuid
        FOR UPDATE OF allocation
      `,
      [args.bonLivraisonId, args.allocationId]
    )
    const allocation = allocationResult.rows[0] ?? null
    if (!allocation) throw new HttpError(404, "ALLOCATION_NOT_FOUND", "Allocation de livraison introuvable.")
    const alreadyConfirmed = allocation.latest_event_type === "PICK_CONFIRMED"
    if ((args.mode === "CONFIRM" && alreadyConfirmed) || (args.mode === "RESET" && !alreadyConfirmed)) return

    if (args.mode === "CONFIRM") {
      if (
        !allocation.location_id ||
        !allocation.stock_level_id ||
        allocation.reservation_status !== "ACTIVE" ||
        allocation.stock_movement_line_id ||
        (allocation.lot_id && allocation.lot_status !== "LIBERE")
      ) {
        throw new HttpError(409, "PICK_BLOCKED", "La source de stock n’est pas complète, réservée et libérée.")
      }
      const body = args.body as ConfirmLivraisonPreparationBodyDTO
      if (
        body.input_method === "SCANNER" &&
        !matchesLivraisonPickScanCode(body.scan_code ?? "", allocation)
      ) {
        throw new HttpError(409, "PICK_SCAN_MISMATCH", "Le code scanné ne correspond pas au lot demandé.")
      }
    }

    const correlationId = crypto.randomUUID()
    const inputMethod = args.mode === "CONFIRM"
      ? (args.body as ConfirmLivraisonPreparationBodyDTO).input_method
      : null
    const scanCode = args.mode === "CONFIRM"
      ? (args.body as ConfirmLivraisonPreparationBodyDTO).scan_code
      : null
    await insertPreparationEvent(tx, {
      bonLivraisonId: args.bonLivraisonId,
      allocationId: args.allocationId,
      eventType: args.mode === "CONFIRM" ? "PICK_CONFIRMED" : "PICK_RESET",
      userId: args.userId,
      values: {
        allocation_id: args.allocationId,
        input_method: inputMethod,
        scan_code_sha256: scanCode
          ? crypto.createHash("sha256").update(scanCode.trim()).digest("hex")
          : null,
        correlation_id: correlationId,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
      },
    })
    await tx.query(
      `UPDATE public.bon_livraison SET updated_at = now(), updated_by = $2 WHERE id = $1::uuid`,
      [args.bonLivraisonId, args.userId]
    )
    await repoInsertAuditLog({
      user_id: args.userId,
      body: {
        event_type: "ACTION",
        action: args.mode === "CONFIRM" ? "livraisons.pick.confirmed" : "livraisons.pick.reset",
        page_key: "livraisons",
        entity_type: "bon_livraison",
        entity_id: args.bonLivraisonId,
        path: `/api/v1/livraisons/${args.bonLivraisonId}/preparation/allocations/${args.allocationId}/${args.mode === "CONFIRM" ? "confirm" : "reset"}`,
        client_session_id: null,
        details: {
          allocation_id: args.allocationId,
          input_method: inputMethod,
          correlation_id: correlationId,
        },
      },
      ip: null,
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
      tx,
    })
  })
  const preparation = await repoGetLivraisonPreparation(args.bonLivraisonId)
  if (!preparation) throw new Error("Failed to reload livraison preparation")
  return preparation
}

export function repoConfirmLivraisonPreparation(
  bonLivraisonId: string,
  allocationId: string,
  body: ConfirmLivraisonPreparationBodyDTO,
  userId: number,
  idempotencyKey: string
) {
  return mutatePreparation({
    bonLivraisonId,
    allocationId,
    body,
    userId,
    idempotencyKeyRaw: idempotencyKey,
    mode: "CONFIRM",
  })
}

export function repoResetLivraisonPreparation(
  bonLivraisonId: string,
  allocationId: string,
  body: ResetLivraisonPreparationBodyDTO,
  userId: number,
  idempotencyKey: string
) {
  return mutatePreparation({
    bonLivraisonId,
    allocationId,
    body,
    userId,
    idempotencyKeyRaw: idempotencyKey,
    mode: "RESET",
  })
}
