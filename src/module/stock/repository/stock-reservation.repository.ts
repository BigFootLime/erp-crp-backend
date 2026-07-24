import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type {
  StockReservationDetail,
  StockReservationEvent,
  StockReservationListItem,
} from "../types/stock-reservation.types";
import type {
  ConsumeStockReservationBodyDTO,
  CreateStockReservationBodyDTO,
  ListStockReservationsQueryDTO,
  StockReservationActionBodyDTO,
} from "../validators/stock-reservation.validators";
import {
  assertStockConsumptionAllowed,
  beginStockCommand,
  completeStockCommand,
  getEmplacementMapping,
  lockStockStates,
  stockTargetKey,
  type AuditContext,
} from "./stock.repository";

type Paginated<T> = { items: T[]; total: number };

function reservationSortColumn(sortBy: ListStockReservationsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "updated_at":
      return "reservation.updated_at";
    case "expires_at":
      return "reservation.expires_at";
    case "qty_reserved":
      return "reservation.qty_reserved";
    default:
      return "reservation.created_at";
  }
}

function reservationSortDirection(sortDir: ListStockReservationsQueryDTO["sortDir"]): "ASC" | "DESC" {
  return sortDir === "asc" ? "ASC" : "DESC";
}

function sourceReference(body: CreateStockReservationBodyDTO): {
  source_type: string;
  source_id: string;
  commande_ligne_id: number | null;
  of_id: number | null;
  bon_livraison_ligne_id: string | null;
  affaire_id: number | null;
} {
  switch (body.source.source_type) {
    case "COMMANDE_LIGNE":
      return {
        source_type: body.source.source_type,
        source_id: String(body.source.commande_ligne_id),
        commande_ligne_id: body.source.commande_ligne_id,
        of_id: null,
        bon_livraison_ligne_id: null,
        affaire_id: null,
      };
    case "OF":
      return {
        source_type: body.source.source_type,
        source_id: String(body.source.of_id),
        commande_ligne_id: null,
        of_id: body.source.of_id,
        bon_livraison_ligne_id: null,
        affaire_id: null,
      };
    case "BON_LIVRAISON_LIGNE":
      return {
        source_type: body.source.source_type,
        source_id: body.source.bon_livraison_ligne_id,
        commande_ligne_id: null,
        of_id: null,
        bon_livraison_ligne_id: body.source.bon_livraison_ligne_id,
        affaire_id: null,
      };
    case "AFFAIRE":
      return {
        source_type: body.source.source_type,
        source_id: String(body.source.affaire_id),
        commande_ligne_id: null,
        of_id: null,
        bon_livraison_ligne_id: null,
        affaire_id: body.source.affaire_id,
      };
  }
}

const RESERVATION_SELECT = `
  SELECT
    reservation.id::text AS id,
    reservation.article_id::text AS article_id,
    article.code AS article_code,
    article.designation AS article_designation,
    reservation.location_id::text AS location_id,
    emplacement.magasin_id::text AS magasin_id,
    COALESCE(magasin.code, magasin.code_magasin)::text AS magasin_code,
    emplacement.id::int AS emplacement_id,
    emplacement.code AS emplacement_code,
    reservation.lot_id::text AS lot_id,
    lot.lot_code,
    reservation.stock_batch_id::text AS stock_batch_id,
    reservation.qty_reserved::float8 AS qty_reserved,
    reservation.source_type,
    reservation.source_id,
    reservation.status,
    reservation.reason,
    reservation.expires_at::text AS expires_at,
    reservation.released_at::text AS released_at,
    reservation.consumed_at::text AS consumed_at,
    reservation.consumed_stock_movement_id::text AS consumed_stock_movement_id,
    reservation.row_version::int AS row_version,
    reservation.correlation_id::text AS correlation_id,
    reservation.updated_at::text AS updated_at,
    reservation.created_at::text AS created_at
  FROM public.stock_reservations reservation
  JOIN public.articles article ON article.id = reservation.article_id
  LEFT JOIN public.emplacements emplacement ON emplacement.location_id = reservation.location_id
  LEFT JOIN public.magasins magasin ON magasin.id = emplacement.magasin_id
  LEFT JOIN public.lots lot ON lot.id = reservation.lot_id
`;

export async function repoListStockReservations(
  filters: ListStockReservationsQueryDTO
): Promise<Paginated<StockReservationListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;
  const values: unknown[] = [];
  const where: string[] = [];
  const push = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (filters.article_id) where.push(`reservation.article_id = ${push(filters.article_id)}::uuid`);
  if (filters.magasin_id) where.push(`emplacement.magasin_id = ${push(filters.magasin_id)}::uuid`);
  if (filters.emplacement_id) where.push(`emplacement.id = ${push(filters.emplacement_id)}::bigint`);
  if (filters.lot_id) where.push(`reservation.lot_id = ${push(filters.lot_id)}::uuid`);
  if (filters.status) where.push(`reservation.status = ${push(filters.status)}`);
  if (filters.source_type) where.push(`reservation.source_type = ${push(filters.source_type)}`);
  if (filters.q) {
    const query = `%${filters.q.replace(/[%_]/g, "\\$&")}%`;
    const p = push(query);
    where.push(
      `(
        article.code ILIKE ${p} ESCAPE '\\'
        OR article.designation ILIKE ${p} ESCAPE '\\'
        OR COALESCE(lot.lot_code, '') ILIKE ${p} ESCAPE '\\'
        OR reservation.source_id ILIKE ${p} ESCAPE '\\'
      )`
    );
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const count = await db.query<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM public.stock_reservations reservation
      JOIN public.articles article ON article.id = reservation.article_id
      LEFT JOIN public.emplacements emplacement ON emplacement.location_id = reservation.location_id
      LEFT JOIN public.lots lot ON lot.id = reservation.lot_id
      ${whereSql}
    `,
    values
  );
  const rows = await db.query<StockReservationListItem>(
    `
      ${RESERVATION_SELECT}
      ${whereSql}
      ORDER BY ${reservationSortColumn(filters.sortBy)} ${reservationSortDirection(filters.sortDir)}, reservation.id
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, pageSize, offset]
  );
  return { items: rows.rows, total: count.rows[0]?.total ?? 0 };
}

export async function repoGetStockReservation(id: string): Promise<StockReservationDetail | null> {
  const reservation = await db.query<StockReservationListItem>(
    `${RESERVATION_SELECT} WHERE reservation.id = $1::uuid`,
    [id]
  );
  const row = reservation.rows[0] ?? null;
  if (!row) return null;

  const events = await db.query<StockReservationEvent>(
    `
      SELECT
        id::text AS id,
        event_type,
        old_values,
        new_values,
        actor_user_id,
        correlation_id::text AS correlation_id,
        created_at::text AS created_at
      FROM public.stock_reservation_event_log
      WHERE reservation_id = $1::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT 500
    `,
    [id]
  );
  return { reservation: row, events: events.rows };
}

export async function repoCreateStockReservation(
  body: CreateStockReservationBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockReservationDetail> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const command = await beginStockCommand(client, {
      audit,
      idempotency_key: idempotencyKey,
      command_type: "RESERVATION_CREATE",
      request_payload: body,
    });
    if (command.existing) {
      await client.query("COMMIT");
      const existing = await repoGetStockReservation(command.existing.resource_id);
      if (!existing) throw new Error("Idempotent reservation receipt points to a missing reservation");
      return existing;
    }

    const article = await client.query<{ stock_managed: boolean; lot_tracking: boolean }>(
      `SELECT stock_managed, lot_tracking FROM public.articles WHERE id = $1::uuid`,
      [body.article_id]
    );
    const articleSettings = article.rows[0] ?? null;
    if (!articleSettings) throw new HttpError(400, "INVALID_ARTICLE", "Unknown article_id");
    if (!articleSettings.stock_managed) {
      throw new HttpError(409, "ARTICLE_NOT_STOCK_MANAGED", "Article is not managed in stock");
    }
    if (articleSettings.lot_tracking && !body.lot_id) {
      throw new HttpError(409, "LOT_REQUIRED", "A lot-tracked article requires lot_id");
    }

    const location = await getEmplacementMapping(
      client,
      body.magasin_id,
      body.emplacement_id,
      "src"
    );
    const level = await client.query<{ id: string }>(
      `
        SELECT id::text AS id
        FROM public.stock_levels
        WHERE article_id = $1::uuid
          AND location_id = $2::uuid
        LIMIT 1
      `,
      [body.article_id, location.location_id]
    );
    const stockLevelId = level.rows[0]?.id;
    if (!stockLevelId) {
      throw new HttpError(409, "INSUFFICIENT_STOCK", "No stock level exists at this emplacement");
    }

    let stockBatchId: string | null = null;
    if (body.lot_id) {
      const batch = await client.query<{ id: string }>(
        `
          SELECT batch.id::text AS id
          FROM public.stock_batches batch
          JOIN public.lots lot
            ON lot.id = batch.lot_id
           AND lot.article_id = $3::uuid
          WHERE batch.stock_level_id = $1::uuid
            AND batch.lot_id = $2::uuid
          LIMIT 1
        `,
        [stockLevelId, body.lot_id, body.article_id]
      );
      stockBatchId = batch.rows[0]?.id ?? null;
      if (!stockBatchId) {
        throw new HttpError(409, "STOCK_BATCH_MISSING", "The lot has no stock batch at this emplacement");
      }
    }

    const states = await lockStockStates(client, [
      { stock_level_id: stockLevelId, stock_batch_id: stockBatchId },
    ]);
    const state = states.get(
      stockTargetKey({ stock_level_id: stockLevelId, stock_batch_id: stockBatchId })
    );
    if (!state) throw new Error("Locked reservation stock state missing");
    assertStockConsumptionAllowed(state, { movement_type: "RESERVE", qty: body.qty });

    await client.query(
      `
        UPDATE public.stock_levels
        SET qty_reserved = qty_reserved + $2,
            updated_at = now(),
            updated_by = $3
        WHERE id = $1::uuid
      `,
      [stockLevelId, body.qty, audit.user_id]
    );
    if (stockBatchId) {
      await client.query(
        `
          UPDATE public.stock_batches
          SET qty_reserved = qty_reserved + $2
          WHERE id = $1::uuid
        `,
        [stockBatchId, body.qty]
      );
    }

    const source = sourceReference(body);
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO public.stock_reservations (
          article_id,
          location_id,
          lot_id,
          stock_batch_id,
          qty_reserved,
          source_type,
          source_id,
          commande_ligne_id,
          of_id,
          bon_livraison_ligne_id,
          affaire_id,
          status,
          reason,
          expires_at,
          correlation_id,
          created_by,
          updated_by
        )
        VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,
          $8::bigint,$9::bigint,$10::uuid,$11::bigint,
          'ACTIVE',$12,$13::timestamptz,$14::uuid,$15,$15
        )
        RETURNING id::text AS id
      `,
      [
        body.article_id,
        location.location_id,
        body.lot_id ?? null,
        stockBatchId,
        body.qty,
        source.source_type,
        source.source_id,
        source.commande_ligne_id,
        source.of_id,
        source.bon_livraison_ligne_id,
        source.affaire_id,
        body.reason,
        body.expires_at ?? null,
        command.correlation_id,
        audit.user_id,
      ]
    );
    const reservationId = inserted.rows[0]?.id;
    if (!reservationId) throw new Error("Failed to create stock reservation");

    await completeStockCommand(client, {
      audit,
      command,
      command_type: "RESERVATION_CREATE",
      resource_type: "stock_reservation",
      resource_id: reservationId,
      result_payload: {
        reservation_id: reservationId,
        status: "ACTIVE",
        qty_reserved: body.qty,
      },
    });
    await client.query("COMMIT");

    const out = await repoGetStockReservation(reservationId);
    if (!out) throw new Error("Failed to reload stock reservation");
    return out;
  } catch (error) {
    await client.query("ROLLBACK");
    const pgCode = (error as { code?: unknown })?.code;
    if (pgCode === "23503") {
      throw new HttpError(409, "INVALID_SOURCE_REFERENCE", "Reservation source does not exist");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function transitionReservation(
  id: string,
  audit: AuditContext,
  idempotencyKey: string,
  args:
    | {
        command_type: "RESERVATION_RELEASE";
        body: StockReservationActionBodyDTO;
      }
    | {
        command_type: "RESERVATION_CONSUME";
        body: ConsumeStockReservationBodyDTO;
      }
): Promise<StockReservationDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const command = await beginStockCommand(client, {
      audit,
      idempotency_key: idempotencyKey,
      command_type: args.command_type,
      request_payload: { reservation_id: id, ...args.body },
    });
    if (command.existing) {
      await client.query("COMMIT");
      return repoGetStockReservation(command.existing.resource_id);
    }

    const reservation = await client.query<{
      article_id: string;
      location_id: string;
      stock_batch_id: string | null;
      qty_reserved: number;
      status: string;
      row_version: number;
    }>(
      `
        SELECT
          article_id::text AS article_id,
          location_id::text AS location_id,
          stock_batch_id::text AS stock_batch_id,
          qty_reserved::float8 AS qty_reserved,
          status,
          row_version::int AS row_version
        FROM public.stock_reservations
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [id]
    );
    const row = reservation.rows[0] ?? null;
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    if (row.status !== "ACTIVE") {
      throw new HttpError(409, "INVALID_STATUS", "Only ACTIVE reservations can transition");
    }
    if (row.row_version !== args.body.expected_version) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Reservation version has changed");
    }

    const level = await client.query<{ id: string }>(
      `
        SELECT id::text AS id
        FROM public.stock_levels
        WHERE article_id = $1::uuid
          AND location_id = $2::uuid
        LIMIT 1
      `,
      [row.article_id, row.location_id]
    );
    const stockLevelId = level.rows[0]?.id;
    if (!stockLevelId) throw new HttpError(409, "STOCK_LEVEL_MISSING", "Reservation stock level is missing");

    const states = await lockStockStates(client, [
      { stock_level_id: stockLevelId, stock_batch_id: row.stock_batch_id },
    ]);
    const state = states.get(
      stockTargetKey({ stock_level_id: stockLevelId, stock_batch_id: row.stock_batch_id })
    );
    if (!state) throw new Error("Locked reservation stock state missing");
    assertStockConsumptionAllowed(state, {
      movement_type: "UNRESERVE",
      qty: row.qty_reserved,
    });

    let consumedMovementId: string | null = null;
    if (args.command_type === "RESERVATION_CONSUME") {
      const movement = await client.query<{ id: string }>(
        `
          SELECT id::text AS id
          FROM public.stock_movements
          WHERE id = $1::uuid
            AND status::text = 'POSTED'
            AND movement_type::text = 'OUT'
            AND article_id = $2::uuid
            AND stock_level_id = $3::uuid
            AND (stock_batch_id IS NOT DISTINCT FROM $4::uuid)
            AND ABS(qty) + 1e-9 >= $5
          LIMIT 1
        `,
        [
          args.body.stock_movement_id,
          row.article_id,
          stockLevelId,
          row.stock_batch_id,
          row.qty_reserved,
        ]
      );
      consumedMovementId = movement.rows[0]?.id ?? null;
      if (!consumedMovementId) {
        throw new HttpError(
          409,
          "MOVEMENT_RESERVATION_MISMATCH",
          "A matching posted OUT movement is required to consume a reservation"
        );
      }
    }

    await client.query(
      `
        UPDATE public.stock_levels
        SET qty_reserved = qty_reserved - $2,
            updated_at = now(),
            updated_by = $3
        WHERE id = $1::uuid
      `,
      [stockLevelId, row.qty_reserved, audit.user_id]
    );
    if (row.stock_batch_id) {
      await client.query(
        `
          UPDATE public.stock_batches
          SET qty_reserved = qty_reserved - $2
          WHERE id = $1::uuid
        `,
        [row.stock_batch_id, row.qty_reserved]
      );
    }

    const nextStatus = args.command_type === "RESERVATION_CONSUME" ? "CONSUMED" : "RELEASED";
    await client.query(
      `
        UPDATE public.stock_reservations
        SET
          status = $2,
          reason = $3,
          released_at = CASE WHEN $2 = 'RELEASED' THEN now() ELSE released_at END,
          released_by = CASE WHEN $2 = 'RELEASED' THEN $4 ELSE released_by END,
          consumed_at = CASE WHEN $2 = 'CONSUMED' THEN now() ELSE consumed_at END,
          consumed_by = CASE WHEN $2 = 'CONSUMED' THEN $4 ELSE consumed_by END,
          consumed_stock_movement_id = $5::uuid,
          correlation_id = $6::uuid,
          updated_at = now(),
          updated_by = $4
        WHERE id = $1::uuid
      `,
      [
        id,
        nextStatus,
        args.body.reason,
        audit.user_id,
        consumedMovementId,
        command.correlation_id,
      ]
    );

    await completeStockCommand(client, {
      audit,
      command,
      command_type: args.command_type,
      resource_type: "stock_reservation",
      resource_id: id,
      result_payload: {
        reservation_id: id,
        status: nextStatus,
        consumed_stock_movement_id: consumedMovementId,
      },
    });
    await client.query("COMMIT");
    return repoGetStockReservation(id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function repoReleaseStockReservation(
  id: string,
  body: StockReservationActionBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockReservationDetail | null> {
  return transitionReservation(id, audit, idempotencyKey, {
    command_type: "RESERVATION_RELEASE",
    body,
  });
}

export function repoConsumeStockReservation(
  id: string,
  body: ConsumeStockReservationBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockReservationDetail | null> {
  return transitionReservation(id, audit, idempotencyKey, {
    command_type: "RESERVATION_CONSUME",
    body,
  });
}
