import type { PoolClient } from "pg";
import { stockLotTraceReferenceValuesSql } from "../../../shared/provenance/stock-lot-trace.sql";
import { readMaterialBarCountRequirementsTx } from './material-bar-count-read-model.repository';
import {
applyMaterialBarCountTx,loadMaterialBarCountLinesTx,
prepareMaterialBarCountEntryTx,
prepareMaterialBarCountSessionTx,
readMaterialBarCountsTx,
recordMaterialBarCountTx
} from './material-bar-count.repository';

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type {
Paginated,
StockInventorySessionDetail,
StockInventorySessionLine,
StockInventorySessionListItem
} from "../types/stock.types";
import type {
CancelInventorySessionBodyDTO,
CreateInventorySessionBodyDTO,
InventorySessionActionBodyDTO,
ListInventorySessionsQueryDTO,
UpsertInventoryLineBodyDTO
} from "../validators/stock.validators";

import type {
AuditContext
} from "./stock-movement-core.repository";
import {
assertStockConsumptionAllowed,
beginStockCommand,
completeStockCommand,
insertAuditLog,
insertMovementEvent,
lockStockStates,
reserveMovementNo,
stockTargetKey
} from "./stock-movement-core.repository";
import { normalizeLikeQuery,sortDirection } from "./stock-query.repository";



function inventorySessionSortColumn(sortBy: ListInventorySessionsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "s.created_at";
    case "updated_at":
      return "s.updated_at";
    case "session_no":
      return "s.session_no";
    case "started_at":
    default:
      return "s.started_at";
  }
}

function inventorySessionNoFromSeq(n: number): string {
  const padded = String(n).padStart(8, "0");
  return `INV-${padded}`;
}

async function reserveInventorySessionNo(client: Pick<PoolClient, "query">): Promise<string> {
  const res = await client.query<{ n: string }>(`SELECT nextval('public.stock_inventory_session_no_seq')::text AS n`);
  const raw = res.rows[0]?.n;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new Error("Failed to reserve inventory session number");
  return inventorySessionNoFromSeq(n);
}

function inventoryScopeSegment(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function reserveInventorySessionNoForScope(
  client: Pick<PoolClient, "query">,
  body: CreateInventorySessionBodyDTO
): Promise<string> {
  if (!body.scope_magasin_id) return reserveInventorySessionNo(client);
  const scope = await client.query<{ magasin_code: string; rayon_code: string | null }>(
    `SELECT
       COALESCE(magasin.code, magasin.code_magasin)::text AS magasin_code,
       emplacement.code::text AS rayon_code
     FROM public.magasins magasin
     LEFT JOIN public.emplacements emplacement
       ON emplacement.id = $2::bigint AND emplacement.magasin_id = magasin.id
     WHERE magasin.id = $1::uuid`,
    [body.scope_magasin_id, body.scope_emplacement_id ?? null]
  );
  const row = scope.rows[0];
  if (!row) return reserveInventorySessionNo(client);
  const parts = [row.magasin_code, row.rayon_code, body.scope_article_prefix]
    .map((part) => inventoryScopeSegment(part ?? ""))
    .filter(Boolean);
  if (parts.length < 2) return reserveInventorySessionNo(client);
  const base = parts.join("/");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`inventory-session:${base}`]);
  const existing = await client.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total
     FROM public.stock_inventory_sessions
     WHERE session_no = $1 OR session_no LIKE $1 || '-%'`,
    [base]
  );
  const total = existing.rows[0]?.total ?? 0;
  return total === 0 ? base : `${base}-${String(total + 1).padStart(2, "0")}`;
}

export async function repoListInventorySessions(
  filters: ListInventorySessionsQueryDTO
): Promise<Paginated<StockInventorySessionListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const q = normalizeLikeQuery(filters.q);
    const p = push(q);
    where.push(`(s.session_no ILIKE ${p} OR COALESCE(s.notes, '') ILIKE ${p})`);
  }
  if (filters.status) where.push(`s.status = ${push(filters.status)}`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = inventorySessionSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.stock_inventory_sessions s ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      s.id::text AS id,
      s.session_no,
      s.status,
      s.scope_magasin_id::text AS scope_magasin_id,
      s.scope_emplacement_id::int AS scope_emplacement_id,
      s.scope_article_id::text AS scope_article_id,
      s.scope_article_category,
      s.scope_article_prefix,
      COALESCE(scope_magasin.code, scope_magasin.code_magasin)::text AS scope_magasin_code,
      scope_emplacement.code::text AS scope_rayon_code,
      s.blind_count,
      s.requires_second_count,
      s.snapshot_at::text AS snapshot_at,
      s.approved_at::text AS approved_at,
      s.cancelled_at::text AS cancelled_at,
      s.cancellation_reason,
      s.row_version::int AS row_version,
      s.correlation_id::text AS correlation_id,
      s.started_at::text AS started_at,
      s.closed_at::text AS closed_at,
      s.notes,
      s.updated_at::text AS updated_at,
      s.created_at::text AS created_at,
      COALESCE(agg.adjustment_movements_count, 0)::int AS adjustment_movements_count,
      last.last_adjustment_movement_id,
      COALESCE(progress.lines_count, 0)::int AS lines_count,
      COALESCE(progress.counted_lines_count, 0)::int AS counted_lines_count
    FROM public.stock_inventory_sessions s
    LEFT JOIN public.magasins scope_magasin ON scope_magasin.id = s.scope_magasin_id
    LEFT JOIN public.emplacements scope_emplacement ON scope_emplacement.id = s.scope_emplacement_id
    LEFT JOIN (
      SELECT link.session_id, COUNT(*)::int AS adjustment_movements_count
      FROM public.stock_inventory_session_movements link
      JOIN public.stock_movements movement ON movement.id = link.stock_movement_id
      WHERE movement.status <> 'CANCELLED'
      GROUP BY link.session_id
    ) agg ON agg.session_id = s.id
    LEFT JOIN (
      SELECT snapshot.session_id,
             COUNT(*)::int AS lines_count,
             COUNT(DISTINCT event.snapshot_line_id)::int AS counted_lines_count
      FROM public.stock_inventory_snapshot_lines snapshot
      LEFT JOIN public.stock_inventory_count_events event ON event.snapshot_line_id = snapshot.id
      GROUP BY snapshot.session_id
    ) progress ON progress.session_id = s.id
    LEFT JOIN LATERAL (
      SELECT sim.stock_movement_id::text AS last_adjustment_movement_id
      FROM public.stock_inventory_session_movements sim
      JOIN public.stock_movements movement ON movement.id = sim.stock_movement_id
      WHERE sim.session_id = s.id
        AND movement.status <> 'CANCELLED'
      ORDER BY sim.created_at DESC, sim.id DESC
      LIMIT 1
    ) last ON true
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockInventorySessionListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

export async function repoCreateInventorySession(
  body: CreateInventorySessionBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockInventorySessionListItem> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const command = await beginStockCommand(client, {
      audit,
      idempotency_key: idempotencyKey,
      command_type: "INVENTORY_CREATE",
      request_payload: { phase: "CREATE_DRAFT", ...body },
    });
    if (command.existing) {
      await client.query("COMMIT");
      const existing = await repoGetInventorySession(command.existing.resource_id);
      if (!existing) throw new Error("Idempotent inventory receipt points to a missing session");
      return existing.session;
    }

    const sessionNo = await reserveInventorySessionNoForScope(client, body);
    const ins = await client.query<{ id: string }>(
      `
        INSERT INTO public.stock_inventory_sessions (
          session_no,
          status,
          started_at,
          notes,
          scope_magasin_id,
          scope_emplacement_id,
          scope_article_id,
          scope_article_category,
          scope_article_prefix,
          blind_count,
          requires_second_count,
          correlation_id,
          created_by,
          updated_by
        )
        VALUES ($1,'DRAFT',NULL,$2,$3::uuid,$4::bigint,$5::uuid,$6,$7,$8,$9,$10::uuid,$11,$11)
        RETURNING id::text AS id
      `,
      [
        sessionNo,
        body.notes ?? null,
        body.scope_magasin_id ?? null,
        body.scope_emplacement_id ?? null,
        body.scope_article_id ?? null,
        body.scope_article_category ?? null,
        body.scope_article_prefix ?? null,
        body.blind_count,
        body.requires_second_count,
        command.correlation_id,
        audit.user_id,
      ]
    );
    const id = ins.rows[0]?.id;
    if (!id) throw new Error("Failed to create inventory session");

    await insertAuditLog(client, audit, {
      action: "stock.inventory_sessions.create",
      entity_type: "stock_inventory_sessions",
      entity_id: id,
      details: {
        session_no: sessionNo,
        status: "DRAFT",
        scope: {
          magasin_id: body.scope_magasin_id ?? null,
          emplacement_id: body.scope_emplacement_id ?? null,
          article_id: body.scope_article_id ?? null,
          article_category: body.scope_article_category ?? null,
          article_prefix: body.scope_article_prefix ?? null,
        },
      },
    });

    await completeStockCommand(client, {
      audit,
      command,
      command_type: "INVENTORY_CREATE",
      resource_type: "stock_inventory_session",
      resource_id: id,
      result_payload: { inventory_session_id: id, session_no: sessionNo, status: "DRAFT" },
    });

    await client.query("COMMIT");

    const out = await repoGetInventorySession(id);
    if (!out) throw new Error("Failed to read created inventory session");
    return out.session;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoStartInventorySession(
  id: string,
  body: InventorySessionActionBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockInventorySessionDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const command = await beginStockCommand(client, {
      audit,
      idempotency_key: idempotencyKey,
      command_type: "INVENTORY_START",
      request_payload: { inventory_session_id: id, ...body },
    });
    if (command.existing) {
      await client.query("COMMIT");
      return repoGetInventorySession(command.existing.resource_id);
    }

    const session = await client.query<{
      status: string;
      session_no: string;
      row_version: number;
      scope_magasin_id: string | null;
      scope_emplacement_id: number | null;
      scope_article_id: string | null;
      scope_article_category: string | null;
      scope_article_prefix: string | null;
    }>(
      `
        SELECT
          status,
          session_no,
          row_version::int AS row_version,
          scope_magasin_id::text AS scope_magasin_id,
          scope_emplacement_id::int AS scope_emplacement_id,
          scope_article_id::text AS scope_article_id,
          scope_article_category,
          scope_article_prefix
        FROM public.stock_inventory_sessions
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [id]
    );
    const row = session.rows[0] ?? null;
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    if (row.status !== "DRAFT") {
      throw new HttpError(409, "INVALID_STATUS", "Only DRAFT inventory sessions can be started");
    }
    if (row.row_version !== body.expected_version) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Inventory session version has changed");
    }

    if (row.scope_emplacement_id && row.scope_magasin_id) {
      const scopedLocation = await client.query<{ ok: number }>(
        `
          SELECT 1::int AS ok
          FROM public.emplacements emplacement
          JOIN public.magasins magasin ON magasin.id = emplacement.magasin_id
          WHERE emplacement.id = $1::bigint
            AND magasin.id = $2::uuid
            AND emplacement.is_active = true
            AND magasin.is_active = true
        `,
        [row.scope_emplacement_id, row.scope_magasin_id]
      );
      if (!scopedLocation.rows[0]?.ok) {
        throw new HttpError(409, "INVENTORY_SCOPE_INVALID", "Scoped emplacement is inactive or outside magasin");
      }
    }

    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO public.stock_inventory_snapshot_lines (
          session_id,
          line_no,
          article_id,
          magasin_id,
          emplacement_id,
          lot_id,
          stock_level_id,
          stock_batch_id,
          theoretical_qty,
          unit_code
        )
        SELECT
          $1::uuid,
          row_number() OVER (
            ORDER BY COALESCE(article_version.plan_reference, article.code),
                     article_version.indice, magasin.id, emplacement.code,
                     availability.lot_code NULLS FIRST
          )::int,
          availability.article_id,
          magasin.id,
          emplacement.id,
          availability.lot_id,
          availability.stock_level_id,
          availability.stock_batch_id,
          availability.qty_on_hand,
          unit.code::text
        FROM public.v_stock_availability_225 availability
        JOIN public.articles article ON article.id = availability.article_id
        JOIN public.emplacements emplacement ON emplacement.location_id = availability.location_id
        JOIN public.magasins magasin ON magasin.id = emplacement.magasin_id
        JOIN public.units unit ON unit.id = availability.unit_id
        LEFT JOIN public.pieces_techniques piece ON piece.id = article.piece_technique_id
        LEFT JOIN LATERAL (
          SELECT version.plan_reference, version.indice
          FROM public.piece_technique_versions version
          WHERE version.piece_technique_id = piece.id
          ORDER BY (version.statut = 'APPLICABLE') DESC, version.is_current DESC,
                   version.version_interne DESC, version.created_at DESC
          LIMIT 1
        ) article_version ON true
        WHERE availability.managed_in_stock = true
          AND availability.qty_on_hand > 0
          AND magasin.is_active = true
          AND emplacement.is_active = true
          AND ($2::uuid IS NULL OR magasin.id = $2::uuid)
          AND ($3::bigint IS NULL OR emplacement.id = $3::bigint)
          AND ($4::uuid IS NULL OR article.id = $4::uuid)
          AND ($5::text IS NULL OR article.article_category::text = $5::text)
          AND (
            $6::text IS NULL
            OR COALESCE(article_version.plan_reference, article.code) ILIKE $6::text || '%'
          )
        RETURNING id::text AS id
      `,
      [
        id,
        row.scope_magasin_id,
        row.scope_emplacement_id,
        row.scope_article_id,
        row.scope_article_category,
        row.scope_article_prefix,
      ]
    );
    if (!inserted.rows.length) {
      throw new HttpError(409, "INVENTORY_SCOPE_EMPTY", "Inventory scope contains no stock balance");
    }

    await client.query(
      `
        UPDATE public.stock_inventory_sessions
        SET
          status = 'OPEN',
          started_at = now(),
          snapshot_at = now(),
          row_version = row_version + 1,
          correlation_id = $2::uuid,
          updated_at = now(),
          updated_by = $3
        WHERE id = $1::uuid
      `,
      [id, command.correlation_id, audit.user_id]
    );
    await insertAuditLog(client, audit, {
      action: "stock.inventory_sessions.start",
      entity_type: "stock_inventory_sessions",
      entity_id: id,
      details: {
        session_no: row.session_no,
        snapshot_lines_count: inserted.rows.length,
        correlation_id: command.correlation_id,
      },
    });
    await completeStockCommand(client, {
      audit,
      command,
      command_type: "INVENTORY_START",
      resource_type: "stock_inventory_session",
      resource_id: id,
      result_payload: {
        inventory_session_id: id,
        status: "OPEN",
        snapshot_lines_count: inserted.rows.length,
      },
    });
    await client.query("COMMIT");
    return repoGetInventorySession(id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function repoGetInventorySessionRow(id: string): Promise<StockInventorySessionListItem | null> {
  const res = await db.query<StockInventorySessionListItem>(
    `
      SELECT
        s.id::text AS id,
        s.session_no,
        s.status,
        s.scope_magasin_id::text AS scope_magasin_id,
        s.scope_emplacement_id::int AS scope_emplacement_id,
        s.scope_article_id::text AS scope_article_id,
        s.scope_article_category,
        s.scope_article_prefix,
        COALESCE(scope_magasin.code, scope_magasin.code_magasin)::text AS scope_magasin_code,
        scope_emplacement.code::text AS scope_rayon_code,
        s.blind_count,
        s.requires_second_count,
        s.snapshot_at::text AS snapshot_at,
        s.approved_at::text AS approved_at,
        s.cancelled_at::text AS cancelled_at,
        s.cancellation_reason,
        s.row_version::int AS row_version,
        s.correlation_id::text AS correlation_id,
        s.started_at::text AS started_at,
        s.closed_at::text AS closed_at,
        s.notes,
        s.updated_at::text AS updated_at,
        s.created_at::text AS created_at,
        COALESCE(agg.adjustment_movements_count, 0)::int AS adjustment_movements_count,
        last.last_adjustment_movement_id,
        COALESCE(progress.lines_count, 0)::int AS lines_count,
        COALESCE(progress.counted_lines_count, 0)::int AS counted_lines_count
      FROM public.stock_inventory_sessions s
      LEFT JOIN public.magasins scope_magasin ON scope_magasin.id = s.scope_magasin_id
      LEFT JOIN public.emplacements scope_emplacement ON scope_emplacement.id = s.scope_emplacement_id
      LEFT JOIN (
        SELECT link.session_id, COUNT(*)::int AS adjustment_movements_count
        FROM public.stock_inventory_session_movements link
        JOIN public.stock_movements movement ON movement.id = link.stock_movement_id
        WHERE movement.status <> 'CANCELLED'
        GROUP BY link.session_id
      ) agg ON agg.session_id = s.id
      LEFT JOIN (
        SELECT snapshot.session_id,
               COUNT(*)::int AS lines_count,
               COUNT(DISTINCT event.snapshot_line_id)::int AS counted_lines_count
        FROM public.stock_inventory_snapshot_lines snapshot
        LEFT JOIN public.stock_inventory_count_events event ON event.snapshot_line_id = snapshot.id
        GROUP BY snapshot.session_id
      ) progress ON progress.session_id = s.id
      LEFT JOIN LATERAL (
        SELECT sim.stock_movement_id::text AS last_adjustment_movement_id
        FROM public.stock_inventory_session_movements sim
        JOIN public.stock_movements movement ON movement.id = sim.stock_movement_id
        WHERE sim.session_id = s.id
          AND movement.status <> 'CANCELLED'
        ORDER BY sim.created_at DESC, sim.id DESC
        LIMIT 1
      ) last ON true
      WHERE s.id = $1::uuid
    `,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function repoGetInventorySession(id: string): Promise<StockInventorySessionDetail | null> {
  const session = await repoGetInventorySessionRow(id);
  if (!session) return null;

  const lines = await repoListInventorySessionLines(id);
  if (!lines) return null;

  const ids = await db.query<{ id: string }>(
    `
      SELECT link.stock_movement_id::text AS id
      FROM public.stock_inventory_session_movements link
      JOIN public.stock_movements movement ON movement.id = link.stock_movement_id
      WHERE link.session_id = $1::uuid
        AND movement.status <> 'CANCELLED'
      ORDER BY link.created_at ASC, link.id ASC
    `,
    [id]
  );

  return {
    session,
    lines,
    adjustment_movement_ids: ids.rows.map((r) => r.id),
  };
}

export async function repoListInventorySessionLines(id: string): Promise<StockInventorySessionLine[] | null> {
  const res = await queryInventorySessionLines(id, null);
  return res;
}

async function queryInventorySessionLines(
  sessionId: string,
  lineId: string | null
): Promise<StockInventorySessionLine[] | null> {
  const session = await db.query<{ ok: number }>(
    `SELECT 1::int AS ok FROM public.stock_inventory_sessions WHERE id = $1::uuid`,
    [sessionId]
  );
  if (!session.rows[0]?.ok) return null;

  const res = await db.query<StockInventorySessionLine>(
    `
      SELECT
        COALESCE(materialized.id, snapshot.id)::text AS id,
        snapshot.id::text AS snapshot_line_id,
        snapshot.session_id::text AS session_id,
        snapshot.line_no::int AS line_no,
        snapshot.stock_batch_id::text AS stock_batch_id,
        latest_count.id::text AS count_event_id,
        snapshot.article_id::text AS article_id,
        article.code AS article_code,
        article.designation AS article_designation,
        COALESCE(technical_version.plan_reference, latest_version.plan_reference) AS article_reference,
        technical_version.id::text AS piece_technique_version_id,
        technical_version.indice AS piece_technique_indice,
        snapshot.magasin_id::text AS magasin_id,
        COALESCE(magasin.code, magasin.code_magasin)::text AS magasin_code,
        COALESCE(magasin.name, magasin.libelle)::text AS magasin_name,
        snapshot.emplacement_id::int AS emplacement_id,
        emplacement.code AS emplacement_code,
        emplacement.name AS emplacement_name,
        snapshot.lot_id::text AS lot_id,
        lot.lot_code AS lot_code,
        COALESCE(traceability.of_references, ARRAY[]::text[]) AS of_references,
        COALESCE(traceability.mp_references, ARRAY[]::text[]) AS mp_references,
        COALESCE(traceability.tr_references, ARRAY[]::text[]) AS tr_references,
        latest_count.counted_qty::float8 AS counted_qty,
        CASE
          WHEN session.blind_count = true AND session.status = 'OPEN' THEN NULL
          ELSE snapshot.theoretical_qty::float8
        END AS qty_on_hand,
        CASE
          WHEN latest_count.counted_qty IS NULL THEN NULL
          WHEN session.blind_count = true AND session.status = 'OPEN' THEN NULL
          ELSE (latest_count.counted_qty - snapshot.theoretical_qty)::float8
        END AS delta_qty,
        latest_count.count_round::int AS count_round,
        latest_count.reason_code,
        latest_count.note,
        COALESCE(latest_count.created_at, snapshot.created_at)::text AS updated_at,
        snapshot.created_at::text AS created_at
      FROM public.stock_inventory_snapshot_lines snapshot
      JOIN public.stock_inventory_sessions session ON session.id = snapshot.session_id
      JOIN public.articles article ON article.id = snapshot.article_id
      JOIN public.magasins magasin ON magasin.id = snapshot.magasin_id
      JOIN public.emplacements emplacement ON emplacement.id = snapshot.emplacement_id
      LEFT JOIN public.lots lot ON lot.id = snapshot.lot_id
      LEFT JOIN public.piece_technique_versions technical_version
        ON technical_version.id = lot.piece_technique_version_id
      LEFT JOIN LATERAL (
        SELECT version.plan_reference
        FROM public.piece_technique_versions version
        WHERE version.piece_technique_id = article.piece_technique_id
        ORDER BY (version.statut = 'APPLICABLE') DESC, version.is_current DESC,
                 version.version_interne DESC, version.created_at DESC
        LIMIT 1
      ) latest_version ON true
      LEFT JOIN LATERAL (
        SELECT
          ARRAY(
            SELECT DISTINCT reference_value
            FROM (
              SELECT reference.reference_value
              FROM public.stock_lot_trace_references reference
              WHERE reference.lot_id = snapshot.lot_id AND reference.reference_type = 'OF'
              UNION ALL
              SELECT fabrication.numero
              FROM public.of_output_lots output
              JOIN public.ordres_fabrication fabrication ON fabrication.id = output.of_id
              WHERE output.lot_id = snapshot.lot_id
            ) values_of(reference_value)
            WHERE reference_value IS NOT NULL AND btrim(reference_value) <> ''
            ORDER BY reference_value
          ) AS of_references,
          ARRAY(
            SELECT DISTINCT reference_value
            FROM (${stockLotTraceReferenceValuesSql("snapshot.lot_id", "MP_LOT")}) recorded_origins
            WHERE reference_value IS NOT NULL AND btrim(reference_value) <> ''
            ORDER BY reference_value
          ) AS mp_references,
          ARRAY(
            SELECT DISTINCT reference_value
            FROM (${stockLotTraceReferenceValuesSql("snapshot.lot_id", "TRAITEMENT_LOT")}) recorded_origins
            WHERE reference_value IS NOT NULL AND btrim(reference_value) <> ''
            ORDER BY reference_value
          ) AS tr_references
      ) traceability ON snapshot.lot_id IS NOT NULL
      LEFT JOIN public.stock_inventory_lines materialized
        ON materialized.session_id = snapshot.session_id
       AND materialized.article_id = snapshot.article_id
       AND materialized.magasin_id = snapshot.magasin_id
       AND materialized.emplacement_id = snapshot.emplacement_id
       AND materialized.lot_id IS NOT DISTINCT FROM snapshot.lot_id
      LEFT JOIN LATERAL (
        SELECT
          event.id,
          event.count_round,
          event.counted_qty,
          event.reason_code,
          event.note,
          event.created_at
        FROM public.stock_inventory_count_events event
        WHERE event.snapshot_line_id = snapshot.id
        ORDER BY event.count_round DESC, event.created_at DESC, event.id DESC
        LIMIT 1
      ) latest_count ON true
      WHERE snapshot.session_id = $1::uuid
        AND (
          $2::uuid IS NULL
          OR materialized.id = $2::uuid
          OR snapshot.id = $2::uuid
        )
      ORDER BY snapshot.line_no ASC, snapshot.id ASC
    `,
    [sessionId, lineId]
  );

  const physicalCounts = await readMaterialBarCountsTx(db,res.rows.flatMap(row=>row.count_event_id?[row.count_event_id]:[]));
  const barRequirements = await readMaterialBarCountRequirementsTx(db, res.rows);
  return res.rows.map(row=>({...row,
    ...barRequirements.get(`${row.article_id}:${row.stock_batch_id ?? ''}`),
    material_bars:row.count_event_id ? physicalCounts.get(row.count_event_id) ?? null : null}));
}

async function repoGetInventoryLineById(lineId: string): Promise<StockInventorySessionLine | null> {
  const session = await db.query<{ session_id: string }>(
    `
      SELECT session_id::text AS session_id
      FROM public.stock_inventory_lines
      WHERE id = $1::uuid
      UNION ALL
      SELECT session_id::text AS session_id
      FROM public.stock_inventory_snapshot_lines
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [lineId]
  );
  const sessionId = session.rows[0]?.session_id;
  if (!sessionId) return null;
  const rows = await queryInventorySessionLines(sessionId, lineId);
  return rows?.[0] ?? null;
}

type InventoryDraftAdjustmentTarget = {
  id: string;
  line_no: number;
  article_id: string;
  magasin_id: string;
  emplacement_id: number;
  lot_id: string | null;
  stock_level_id: string;
  stock_batch_id: string | null;
  theoretical_qty: number;
  unit_code: string;
};

/**
 * Keep one actionable DRAFT adjustment aligned with the latest count for a
 * snapshot line. Saving/pausing therefore leaves an immediate movement trace,
 * while physical stock remains unchanged until the inventory is approved and
 * closed. Superseded drafts are cancelled, never deleted.
 */
async function syncInventoryDraftAdjustment(
  client: PoolClient,
  args: {
    session_id: string;
    session_no: string;
    snapshot: InventoryDraftAdjustmentTarget;
    counted_qty: number;
    reason_code: string | null;
    note: string | null;
    correlation_id: string;
    audit: AuditContext;
  }
): Promise<string | null> {
  const delta = args.counted_qty - args.snapshot.theoretical_qty;
  const existing = await client.query<{
    id: string;
    movement_no: string;
    qty: number;
  }>(
    `
      SELECT
        movement.id::text AS id,
        movement.movement_no,
        movement.qty::float8 AS qty
      FROM public.stock_inventory_session_movements link
      JOIN public.stock_movements movement ON movement.id = link.stock_movement_id
      WHERE link.session_id = $1::uuid
        AND link.snapshot_line_id = $2::uuid
        AND movement.status = 'DRAFT'
      ORDER BY link.created_at DESC, link.id DESC
      LIMIT 1
      FOR UPDATE OF movement
    `,
    [args.session_id, args.snapshot.id]
  );
  const draft = existing.rows[0] ?? null;

  if (Math.abs(delta) <= 1e-9) {
    if (!draft) return null;
    await client.query(
      `
        UPDATE public.stock_movements
        SET status = 'CANCELLED', correlation_id = $2::uuid,
            updated_at = now(), updated_by = $3
        WHERE id = $1::uuid
      `,
      [draft.id, args.correlation_id, args.audit.user_id]
    );
    await insertMovementEvent(client, {
      movement_id: draft.id,
      event_type: "CANCELLED",
      old_values: { status: "DRAFT", qty: draft.qty },
      new_values: {
        status: "CANCELLED",
        reason: "INVENTORY_COUNT_MATCHES_SNAPSHOT",
        inventory_session_id: args.session_id,
        snapshot_line_id: args.snapshot.id,
      },
      user_id: args.audit.user_id,
    });
    return null;
  }

  const direction: "IN" | "OUT" = delta > 0 ? "IN" : "OUT";
  const lineNote = args.note ?? args.reason_code ?? `Inventaire ${args.session_no}`;
  if (draft) {
    await client.query(
      `
        UPDATE public.stock_movements
        SET qty = $2, effective_at = now(), reason_code = $3, notes = $4,
            correlation_id = $5::uuid, updated_at = now(), updated_by = $6
        WHERE id = $1::uuid
      `,
      [draft.id, delta, args.reason_code, args.note ?? `Inventaire ${args.session_no}`, args.correlation_id, args.audit.user_id]
    );
    await client.query(
      `
        UPDATE public.stock_movement_lines
        SET qty = $2, direction = $3,
            src_magasin_id = CASE WHEN $3 = 'OUT' THEN $4::uuid ELSE NULL END,
            src_emplacement_id = CASE WHEN $3 = 'OUT' THEN $5::bigint ELSE NULL END,
            dst_magasin_id = CASE WHEN $3 = 'IN' THEN $4::uuid ELSE NULL END,
            dst_emplacement_id = CASE WHEN $3 = 'IN' THEN $5::bigint ELSE NULL END,
            note = $6, updated_at = now(), updated_by = $7
        WHERE movement_id = $1::uuid
      `,
      [draft.id, Math.abs(delta), direction, args.snapshot.magasin_id, args.snapshot.emplacement_id, lineNote, args.audit.user_id]
    );
    await insertMovementEvent(client, {
      movement_id: draft.id,
      event_type: "INVENTORY_DRAFT_UPDATED",
      old_values: { status: "DRAFT", qty: draft.qty },
      new_values: {
        status: "DRAFT",
        qty: delta,
        inventory_session_id: args.session_id,
        snapshot_line_id: args.snapshot.id,
        theoretical_qty: args.snapshot.theoretical_qty,
        counted_qty: args.counted_qty,
      },
      user_id: args.audit.user_id,
    });
    return draft.id;
  }

  const movementNo = await reserveMovementNo(client);
  const movement = await client.query<{ id: string }>(
    `
      INSERT INTO public.stock_movements (
        movement_no, movement_type, status, article_id,
        stock_level_id, stock_batch_id, qty, currency,
        effective_at, source_document_type, source_document_id,
        reason_code, notes, correlation_id,
        user_id, created_by, updated_by
      )
      VALUES (
        $1,'ADJUSTMENT','DRAFT',$2::uuid,$3::uuid,$4::uuid,$5,'EUR',
        now(),'stock_inventory_session',$6::uuid,$7,$8,$9::uuid,$10,$10,$10
      )
      RETURNING id::text AS id
    `,
    [
      movementNo,
      args.snapshot.article_id,
      args.snapshot.stock_level_id,
      args.snapshot.stock_batch_id,
      delta,
      args.session_id,
      args.reason_code ?? "INVENTORY",
      args.note ?? `Inventaire ${args.session_no}`,
      args.correlation_id,
      args.audit.user_id,
    ]
  );
  const movementId = movement.rows[0]?.id;
  if (!movementId) throw new Error("Failed to create inventory draft adjustment");

  await client.query(
    `
      INSERT INTO public.stock_movement_lines (
        movement_id, line_no, article_id, lot_id,
        qty, unite,
        src_magasin_id, src_emplacement_id,
        dst_magasin_id, dst_emplacement_id,
        direction, note, created_by, updated_by
      )
      VALUES (
        $1::uuid,1,$2::uuid,$3::uuid,$4,$5,
        CASE WHEN $6 = 'OUT' THEN $7::uuid ELSE NULL END,
        CASE WHEN $6 = 'OUT' THEN $8::bigint ELSE NULL END,
        CASE WHEN $6 = 'IN' THEN $7::uuid ELSE NULL END,
        CASE WHEN $6 = 'IN' THEN $8::bigint ELSE NULL END,
        $6,$9,$10,$10
      )
    `,
    [
      movementId,
      args.snapshot.article_id,
      args.snapshot.lot_id,
      Math.abs(delta),
      args.snapshot.unit_code,
      direction,
      args.snapshot.magasin_id,
      args.snapshot.emplacement_id,
      lineNote,
      args.audit.user_id,
    ]
  );
  await client.query(
    `
      INSERT INTO public.stock_inventory_session_movements (
        session_id, stock_movement_id, snapshot_line_id
      )
      VALUES ($1::uuid,$2::uuid,$3::uuid)
    `,
    [args.session_id, movementId, args.snapshot.id]
  );
  await insertMovementEvent(client, {
    movement_id: movementId,
    event_type: "CREATED",
    old_values: null,
    new_values: {
      status: "DRAFT",
      movement_type: "ADJUSTMENT",
      qty: delta,
      inventory_session_id: args.session_id,
      snapshot_line_id: args.snapshot.id,
      theoretical_qty: args.snapshot.theoretical_qty,
      counted_qty: args.counted_qty,
    },
    user_id: args.audit.user_id,
  });
  return movementId;
}

export async function repoUpsertInventoryLine(
  sessionId: string,
  body: UpsertInventoryLineBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockInventorySessionLine | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const command = await beginStockCommand(client, {
      audit,
      idempotency_key: idempotencyKey,
      command_type: "INVENTORY_COUNT",
      request_payload: { inventory_session_id: sessionId, ...body },
    });
    if (command.existing) {
      await client.query("COMMIT");
      return repoGetInventoryLineById(command.existing.resource_id);
    }

    const lock = await client.query<{
      status: string;
      session_no: string;
      row_version: number;
      requires_second_count: boolean;
    }>(
      `
        SELECT status, session_no, row_version::int AS row_version, requires_second_count
        FROM public.stock_inventory_sessions
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [sessionId]
    );
    const s = lock.rows[0] ?? null;
    if (!s) {
      await client.query("ROLLBACK");
      return null;
    }
    if (s.status !== "OPEN") {
      throw new HttpError(409, "INVALID_STATUS", "Only OPEN sessions can be edited");
    }
    if (s.row_version !== body.expected_session_version) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Inventory session version has changed");
    }
    if (body.count_round === 2 && !s.requires_second_count) {
      throw new HttpError(409, "SECOND_COUNT_NOT_REQUIRED", "This inventory does not allow a second count");
    }

    const snapshot = await client.query<{
      id: string;
      line_no: number;
      article_id: string;
      magasin_id: string;
      emplacement_id: number;
      lot_id: string | null;
      stock_level_id: string;
      stock_batch_id: string | null;
      theoretical_qty: number;
      unit_code: string;
    }>(
      `
        SELECT
          id::text AS id,
          line_no::int AS line_no,
          article_id::text AS article_id,
          magasin_id::text AS magasin_id,
          emplacement_id::int AS emplacement_id,
          lot_id::text AS lot_id,
          stock_level_id::text AS stock_level_id,
          stock_batch_id::text AS stock_batch_id,
          theoretical_qty::float8 AS theoretical_qty,
          unit_code
        FROM public.stock_inventory_snapshot_lines
        WHERE session_id = $1::uuid
          AND article_id = $2::uuid
          AND magasin_id = $3::uuid
          AND emplacement_id = $4::bigint
          AND lot_id IS NOT DISTINCT FROM $5::uuid
        FOR SHARE
      `,
      [sessionId, body.article_id, body.magasin_id, body.emplacement_id, body.lot_id ?? null]
    );
    const snapshotLine = snapshot.rows[0] ?? null;
    if (!snapshotLine) {
      throw new HttpError(
        409,
        "INVENTORY_SCOPE_MISMATCH",
        "Counted item is outside the frozen inventory scope"
      );
    }
    if (
      Math.abs(body.counted_qty - snapshotLine.theoretical_qty) > 1e-9 &&
      !body.reason_code
    ) {
      throw new HttpError(
        422,
        "INVENTORY_REASON_REQUIRED",
        "A reason code is required for an inventory discrepancy"
      );
    }
    const traceUpdates = [
      ["OF", body.of_references] as const,
      ["MP_LOT", body.mp_references] as const,
      ["TRAITEMENT_LOT", body.tr_references] as const,
    ].filter((entry): entry is readonly ["OF" | "MP_LOT" | "TRAITEMENT_LOT", string[]] => entry[1] !== undefined);
    const physicalCount = await prepareMaterialBarCountEntryTx(client, { line: {
      snapshotId:snapshotLine.id,batchId:snapshotLine.stock_batch_id,articleId:snapshotLine.article_id,
      lotId:snapshotLine.lot_id,theoreticalQty:snapshotLine.theoretical_qty,countedQty:body.counted_qty,
    },body:body.material_bars });
    if (traceUpdates.length > 0 && !body.lot_id) {
      throw new HttpError(
        422,
        "INVENTORY_LOT_REQUIRED_FOR_TRACEABILITY",
        "Les références OF, MP et traitement nécessitent un lot."
      );
    }
    if (traceUpdates.length > 0 && body.lot_id) {
      const previous = await client.query<{ reference_type: string; reference_value: string }>(
        `SELECT reference_type, reference_value
         FROM public.stock_lot_trace_references
         WHERE lot_id = $1::uuid
           AND reference_type = ANY($2::text[])
         ORDER BY reference_type, reference_value`,
        [body.lot_id, traceUpdates.map(([type]) => type)]
      );
      for (const [referenceType, references] of traceUpdates) {
        await client.query(
          `DELETE FROM public.stock_lot_trace_references
           WHERE lot_id = $1::uuid AND reference_type = $2`,
          [body.lot_id, referenceType]
        );
        const normalizedReferences = [...new Set(references.map((reference) => reference.trim()).filter(Boolean))];
        for (const reference of normalizedReferences) {
          await client.query(
            `INSERT INTO public.stock_lot_trace_references
               (lot_id, reference_type, reference_value, created_by)
             VALUES ($1::uuid,$2,$3,$4)
             ON CONFLICT DO NOTHING`,
            [body.lot_id, referenceType, reference, audit.user_id]
          );
        }
      }
      await client.query(
        `INSERT INTO public.stock_lot_event_log (
           lot_id, event_type, old_values, new_values,
           actor_user_id, correlation_id
         )
         VALUES ($1::uuid,'INVENTORY_TRACEABILITY_CORRECTED',$2::jsonb,$3::jsonb,$4,$5::uuid)`,
        [
          body.lot_id,
          JSON.stringify({ references: previous.rows, inventory_session_id: sessionId }),
          JSON.stringify({
            references: traceUpdates.map(([reference_type, references]) => ({
              reference_type,
              values: [...new Set(references.map((reference) => reference.trim()).filter(Boolean))],
            })),
            inventory_session_id: sessionId,
          }),
          audit.user_id,
          command.correlation_id,
        ]
      );
    }
    if (body.count_round === 2) {
      const firstCount = await client.query<{ ok: number }>(
        `
          SELECT 1::int AS ok
          FROM public.stock_inventory_count_events
          WHERE snapshot_line_id = $1::uuid
            AND count_round = 1
          LIMIT 1
        `,
        [snapshotLine.id]
      );
      if (!firstCount.rows[0]?.ok) {
        throw new HttpError(409, "FIRST_COUNT_REQUIRED", "First count is required before second count");
      }
    }

    const countEvent = await client.query<{ id: string }>(
      `
        INSERT INTO public.stock_inventory_count_events (
          session_id,
          snapshot_line_id,
          count_round,
          counted_qty,
          reason_code,
          note,
          actor_user_id,
          correlation_id
        )
        VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::uuid)
        RETURNING id::text AS id
      `,
      [
        sessionId,
        snapshotLine.id,
        body.count_round,
        body.counted_qty,
        body.reason_code ?? null,
        body.note ?? null,
        audit.user_id,
        command.correlation_id,
      ]
    );
    const countEventId = countEvent.rows[0]?.id;
    if (!countEventId) throw new Error("Failed to append inventory count event");
    if (physicalCount) await recordMaterialBarCountTx(client,countEventId,physicalCount);

    const existing = await client.query<{ id: string }>(
      `
        SELECT id::text AS id
        FROM public.stock_inventory_lines
        WHERE session_id = $1::uuid
          AND article_id = $2::uuid
          AND magasin_id = $3::uuid
          AND emplacement_id = $4::bigint
          AND ((lot_id IS NULL AND $5::uuid IS NULL) OR lot_id = $5::uuid)
        FOR UPDATE
      `,
      [sessionId, body.article_id, body.magasin_id, body.emplacement_id, body.lot_id ?? null]
    );

    let lineId: string;
    if (existing.rows[0]?.id) {
      lineId = existing.rows[0].id;
      await client.query(
        `
          UPDATE public.stock_inventory_lines
          SET counted_qty = $2, note = $3, updated_at = now(), updated_by = $4
          WHERE id = $1::uuid
        `,
        [lineId, body.counted_qty, body.note ?? null, audit.user_id]
      );
    } else {
      const ins = await client.query<{ id: string }>(
        `
          INSERT INTO public.stock_inventory_lines (
            session_id, line_no,
            article_id, magasin_id, emplacement_id, lot_id,
            counted_qty, note,
            created_by, updated_by
          )
          VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::bigint,$6::uuid,$7,$8,$9,$9)
          RETURNING id::text AS id
        `,
        [
          sessionId,
          snapshotLine.line_no,
          body.article_id,
          body.magasin_id,
          body.emplacement_id,
          body.lot_id ?? null,
          body.counted_qty,
          body.note ?? null,
          audit.user_id,
        ]
      );
      const idRow = ins.rows[0]?.id;
      if (!idRow) throw new Error("Failed to insert inventory line");
      lineId = idRow;
    }

    const draftAdjustmentMovementId = await syncInventoryDraftAdjustment(client, {
      session_id: sessionId,
      session_no: s.session_no,
      snapshot: snapshotLine,
      counted_qty: body.counted_qty,
      reason_code: body.reason_code ?? null,
      note: body.note ?? null,
      correlation_id: command.correlation_id,
      audit,
    });

    await insertAuditLog(client, audit, {
      action: "stock.inventory_sessions.lines.upsert",
      entity_type: "stock_inventory_lines",
      entity_id: lineId,
      details: {
        session_id: sessionId,
        snapshot_line_id: snapshotLine.id,
        count_event_id: countEventId,
        count_round: body.count_round,
        article_id: body.article_id,
        magasin_id: body.magasin_id,
        emplacement_id: body.emplacement_id,
        lot_id: body.lot_id ?? null,
        counted_qty: body.counted_qty,
        theoretical_qty: snapshotLine.theoretical_qty,
        reason_code: body.reason_code ?? null,
        draft_adjustment_movement_id: draftAdjustmentMovementId,
      },
    });

    await client.query(
      `
        UPDATE public.stock_inventory_sessions
        SET row_version = row_version + 1, updated_at = now(), updated_by = $2
        WHERE id = $1::uuid
      `,
      [sessionId, audit.user_id]
    );

    await completeStockCommand(client, {
      audit,
      command,
      command_type: "INVENTORY_COUNT",
      resource_type: "stock_inventory_line",
      resource_id: lineId,
      result_payload: {
        inventory_session_id: sessionId,
        inventory_line_id: lineId,
        count_event_id: countEventId,
        count_round: body.count_round,
        draft_adjustment_movement_id: draftAdjustmentMovementId,
      },
    });

    await client.query("COMMIT");
    return repoGetInventoryLineById(lineId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoApproveInventorySession(
  id: string,
  body: InventorySessionActionBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockInventorySessionDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const command = await beginStockCommand(client, {
      audit,
      idempotency_key: idempotencyKey,
      command_type: "INVENTORY_APPROVE",
      request_payload: { inventory_session_id: id, ...body },
    });
    if (command.existing) {
      await client.query("COMMIT");
      return repoGetInventorySession(command.existing.resource_id);
    }

    const session = await client.query<{
      status: string;
      session_no: string;
      row_version: number;
      requires_second_count: boolean;
    }>(
      `
        SELECT
          status,
          session_no,
          row_version::int AS row_version,
          requires_second_count
        FROM public.stock_inventory_sessions
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [id]
    );
    const row = session.rows[0] ?? null;
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    if (row.status !== "OPEN") {
      throw new HttpError(409, "INVALID_STATUS", "Only OPEN inventory sessions can be approved");
    }
    if (row.row_version !== body.expected_version) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Inventory session version has changed");
    }

    const readiness = await client.query<{
      lines_count: number;
      missing_first_count: number;
      missing_second_count: number;
      discrepancy_without_reason: number;
    }>(
      `
        SELECT
          COUNT(*)::int AS lines_count,
          COUNT(*) FILTER (WHERE first_count.counted_qty IS NULL)::int AS missing_first_count,
          COUNT(*) FILTER (
            WHERE $2::boolean = true
              AND first_count.counted_qty IS NOT NULL
              AND ABS(first_count.counted_qty - snapshot.theoretical_qty) > 1e-9
              AND second_count.counted_qty IS NULL
          )::int AS missing_second_count,
          COUNT(*) FILTER (
            WHERE COALESCE(second_count.counted_qty, first_count.counted_qty) IS NOT NULL
              AND ABS(COALESCE(second_count.counted_qty, first_count.counted_qty) - snapshot.theoretical_qty) > 1e-9
              AND NULLIF(
                btrim(COALESCE(second_count.reason_code, first_count.reason_code, '')),
                ''
              ) IS NULL
          )::int AS discrepancy_without_reason
        FROM public.stock_inventory_snapshot_lines snapshot
        LEFT JOIN LATERAL (
          SELECT counted_qty, reason_code
          FROM public.stock_inventory_count_events event
          WHERE event.snapshot_line_id = snapshot.id
            AND event.count_round = 1
          ORDER BY event.created_at DESC, event.id DESC
          LIMIT 1
        ) first_count ON true
        LEFT JOIN LATERAL (
          SELECT counted_qty, reason_code
          FROM public.stock_inventory_count_events event
          WHERE event.snapshot_line_id = snapshot.id
            AND event.count_round = 2
          ORDER BY event.created_at DESC, event.id DESC
          LIMIT 1
        ) second_count ON true
        WHERE snapshot.session_id = $1::uuid
      `,
      [id, row.requires_second_count]
    );
    const counts = readiness.rows[0];
    if (!counts || counts.lines_count === 0) {
      throw new HttpError(409, "INVENTORY_SCOPE_EMPTY", "Inventory snapshot contains no lines");
    }
    if (counts.missing_first_count > 0) {
      throw new HttpError(
        409,
        "INVENTORY_COUNTS_INCOMPLETE",
        `${counts.missing_first_count} first counts are missing`
      );
    }
    if (counts.missing_second_count > 0) {
      throw new HttpError(
        409,
        "INVENTORY_SECOND_COUNTS_INCOMPLETE",
        `${counts.missing_second_count} required second counts are missing`
      );
    }
    if (counts.discrepancy_without_reason > 0) {
      throw new HttpError(
        422,
        "INVENTORY_REASON_REQUIRED",
        `${counts.discrepancy_without_reason} discrepancies have no reason`
      );
    }

    await prepareMaterialBarCountSessionTx(client,id,await loadMaterialBarCountLinesTx(client,id),row.requires_second_count);

    await client.query(
      `
        UPDATE public.stock_inventory_sessions
        SET
          status = 'APPROVED',
          approved_at = now(),
          approved_by = $2,
          row_version = row_version + 1,
          correlation_id = $3::uuid,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::uuid
      `,
      [id, audit.user_id, command.correlation_id]
    );
    await insertAuditLog(client, audit, {
      action: "stock.inventory_sessions.approve",
      entity_type: "stock_inventory_sessions",
      entity_id: id,
      details: {
        session_no: row.session_no,
        reason: body.reason ?? null,
        correlation_id: command.correlation_id,
      },
    });
    await completeStockCommand(client, {
      audit,
      command,
      command_type: "INVENTORY_APPROVE",
      resource_type: "stock_inventory_session",
      resource_id: id,
      result_payload: { inventory_session_id: id, status: "APPROVED" },
    });
    await client.query("COMMIT");
    return repoGetInventorySession(id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoCancelInventorySession(
  id: string,
  body: CancelInventorySessionBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockInventorySessionDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const command = await beginStockCommand(client, {
      audit,
      idempotency_key: idempotencyKey,
      command_type: "INVENTORY_CANCEL",
      request_payload: { inventory_session_id: id, ...body },
    });
    if (command.existing) {
      await client.query("COMMIT");
      return repoGetInventorySession(command.existing.resource_id);
    }

    const session = await client.query<{ status: string; session_no: string; row_version: number }>(
      `
        SELECT status, session_no, row_version::int AS row_version
        FROM public.stock_inventory_sessions
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [id]
    );
    const row = session.rows[0] ?? null;
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    if (!["DRAFT", "OPEN", "APPROVED"].includes(row.status)) {
      throw new HttpError(409, "INVALID_STATUS", "Inventory session can no longer be cancelled");
    }
    if (row.row_version !== body.expected_version) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Inventory session version has changed");
    }

    const cancelledDrafts = await client.query<{ id: string; qty: number }>(
      `
        UPDATE public.stock_movements movement
        SET status = 'CANCELLED', correlation_id = $2::uuid,
            updated_at = now(), updated_by = $3
        FROM public.stock_inventory_session_movements link
        WHERE link.session_id = $1::uuid
          AND link.stock_movement_id = movement.id
          AND movement.status = 'DRAFT'
        RETURNING movement.id::text AS id, movement.qty::float8 AS qty
      `,
      [id, command.correlation_id, audit.user_id]
    );
    for (const movement of cancelledDrafts.rows) {
      await insertMovementEvent(client, {
        movement_id: movement.id,
        event_type: "CANCELLED",
        old_values: { status: "DRAFT", qty: movement.qty },
        new_values: {
          status: "CANCELLED",
          reason: "INVENTORY_SESSION_CANCELLED",
          inventory_session_id: id,
        },
        user_id: audit.user_id,
      });
    }

    await client.query(
      `
        UPDATE public.stock_inventory_sessions
        SET
          status = 'CANCELLED',
          cancelled_at = now(),
          cancelled_by = $2,
          cancellation_reason = $3,
          row_version = row_version + 1,
          correlation_id = $4::uuid,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::uuid
      `,
      [id, audit.user_id, body.reason, command.correlation_id]
    );
    await insertAuditLog(client, audit, {
      action: "stock.inventory_sessions.cancel",
      entity_type: "stock_inventory_sessions",
      entity_id: id,
      details: {
        session_no: row.session_no,
        previous_status: row.status,
        reason: body.reason,
        cancelled_draft_adjustments: cancelledDrafts.rows.length,
        correlation_id: command.correlation_id,
      },
    });
    await completeStockCommand(client, {
      audit,
      command,
      command_type: "INVENTORY_CANCEL",
      resource_type: "stock_inventory_session",
      resource_id: id,
      result_payload: { inventory_session_id: id, status: "CANCELLED" },
    });
    await client.query("COMMIT");
    return repoGetInventorySession(id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoCloseInventorySession(
  id: string,
  body: InventorySessionActionBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockInventorySessionDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const command = await beginStockCommand(client, {
      audit,
      idempotency_key: idempotencyKey,
      command_type: "INVENTORY_CLOSE",
      request_payload: { inventory_session_id: id, ...body },
    });
    if (command.existing) {
      await client.query("COMMIT");
      return repoGetInventorySession(command.existing.resource_id);
    }

    const lock = await client.query<{ status: string; session_no: string; row_version: number }>(
      `
        SELECT status, session_no, row_version::int AS row_version
        FROM public.stock_inventory_sessions
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [id]
    );
    const s = lock.rows[0] ?? null;
    if (!s) {
      await client.query("ROLLBACK");
      return null;
    }
    if (s.status !== "APPROVED") {
      throw new HttpError(409, "INVALID_STATUS", "Only APPROVED inventory sessions can be closed");
    }
    if (s.row_version !== body.expected_version) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Inventory session version has changed");
    }

    type InventoryCloseLine = {
      snapshot_line_id: string;
      line_no: number;
      article_id: string;
      magasin_id: string;
      emplacement_id: number;
      lot_id: string | null;
      stock_level_id: string;
      stock_batch_id: string | null;
      theoretical_qty: number;
      counted_qty: number | null;
      unit_code: string;
      reason_code: string | null;
      note: string | null;
    };
    const lines = await client.query<InventoryCloseLine>(
      `
        SELECT
          snapshot.id::text AS snapshot_line_id,
          snapshot.line_no::int AS line_no,
          snapshot.article_id::text AS article_id,
          snapshot.magasin_id::text AS magasin_id,
          snapshot.emplacement_id::int AS emplacement_id,
          snapshot.lot_id::text AS lot_id,
          snapshot.stock_level_id::text AS stock_level_id,
          snapshot.stock_batch_id::text AS stock_batch_id,
          snapshot.theoretical_qty::float8 AS theoretical_qty,
          effective_count.counted_qty::float8 AS counted_qty,
          snapshot.unit_code,
          effective_count.reason_code,
          effective_count.note
        FROM public.stock_inventory_snapshot_lines snapshot
        LEFT JOIN LATERAL (
          SELECT counted_qty, reason_code, note
          FROM public.stock_inventory_count_events event
          WHERE event.snapshot_line_id = snapshot.id
          ORDER BY event.count_round DESC, event.created_at DESC, event.id DESC
          LIMIT 1
        ) effective_count ON true
        WHERE snapshot.session_id = $1::uuid
        ORDER BY snapshot.line_no ASC, snapshot.id ASC
      `,
      [id]
    );

    if (!lines.rows.length) {
      throw new HttpError(409, "INVENTORY_SCOPE_EMPTY", "Inventory snapshot contains no lines");
    }
    const missingCount = lines.rows.filter((line) => line.counted_qty === null).length;
    if (missingCount > 0) {
      throw new HttpError(
        409,
        "INVENTORY_COUNTS_INCOMPLETE",
        `${missingCount} inventory counts are missing`
      );
    }

    const physicalCounts = await prepareMaterialBarCountSessionTx(client,id,await loadMaterialBarCountLinesTx(client,id));
    const states = await lockStockStates(
      client,
      lines.rows.map((line) => ({
        stock_level_id: line.stock_level_id,
        stock_batch_id: line.stock_batch_id,
      }))
    );
    for (const line of lines.rows) {
      const state = states.get(
        stockTargetKey({
          stock_level_id: line.stock_level_id,
          stock_batch_id: line.stock_batch_id,
        })
      );
      if (!state) throw new Error("Locked inventory stock state missing");
      if (Math.abs(state.qty_on_hand - line.theoretical_qty) > 1e-9) {
        throw new HttpError(
          409,
          "INVENTORY_SNAPSHOT_STALE",
          "Stock changed after the inventory snapshot; cancel and restart the inventory",
          {
            snapshot_line_id: line.snapshot_line_id,
            theoretical_qty: line.theoretical_qty,
            current_qty: state.qty_on_hand,
          }
        );
      }
    }

    const adjustments = lines.rows
      .map((line) => ({
        ...line,
        counted_qty: line.counted_qty as number,
        delta_qty: (line.counted_qty as number) - line.theoretical_qty,
      }))
      .filter((line) => Math.abs(line.delta_qty) > 1e-9);
    const postedAt = new Date().toISOString();
    const physicalAdjustmentIds = new Map<string,string>();
    const drafts = await client.query<{
      id: string;
      snapshot_line_id: string;
      qty: number;
    }>(
      `
        SELECT
          movement.id::text AS id,
          link.snapshot_line_id::text AS snapshot_line_id,
          movement.qty::float8 AS qty
        FROM public.stock_inventory_session_movements link
        JOIN public.stock_movements movement ON movement.id = link.stock_movement_id
        WHERE link.session_id = $1::uuid
          AND link.snapshot_line_id IS NOT NULL
          AND movement.status = 'DRAFT'
        ORDER BY link.created_at DESC, link.id DESC
        FOR UPDATE OF movement
      `,
      [id]
    );
    const draftBySnapshotLine = new Map(drafts.rows.map((draft) => [draft.snapshot_line_id, draft]));
    const postedDraftIds = new Set<string>();

    for (const adj of adjustments) {
      const delta = adj.delta_qty;
      const direction: "IN" | "OUT" = delta > 0 ? "IN" : "OUT";
      const state = states.get(
        stockTargetKey({
          stock_level_id: adj.stock_level_id,
          stock_batch_id: adj.stock_batch_id,
        })
      );
      if (!state) throw new Error("Locked inventory stock state missing");
      if (delta < 0) {
        assertStockConsumptionAllowed(state, {
          movement_type: "ADJUSTMENT",
          qty: delta,
          allow_nonreleased_adjustment: true,
        });
      }
      const draft = draftBySnapshotLine.get(adj.snapshot_line_id) ?? null;
      let movementId: string;
      if (draft) {
        if (Math.abs(draft.qty - delta) > 1e-9) {
          throw new HttpError(409, "INVENTORY_DRAFT_MISMATCH", "Inventory draft adjustment no longer matches the approved count");
        }
        movementId = draft.id;
        postedDraftIds.add(draft.id);
        await client.query(
          `
            UPDATE public.stock_movements
            SET status = 'POSTED', posted_at = $2, posted_by = $3,
                notes = COALESCE($4, notes), correlation_id = $5::uuid,
                updated_at = now(), updated_by = $3
            WHERE id = $1::uuid
          `,
          [movementId, postedAt, audit.user_id, body.reason ?? null, command.correlation_id]
        );
        await insertMovementEvent(client, {
          movement_id: movementId,
          event_type: "POSTED",
          old_values: { status: "DRAFT", qty: delta },
          new_values: {
            status: "POSTED",
            movement_type: "ADJUSTMENT",
            delta,
            inventory_session_id: id,
            snapshot_line_id: adj.snapshot_line_id,
            theoretical_qty: adj.theoretical_qty,
            counted_qty: adj.counted_qty,
            correlation_id: command.correlation_id,
          },
          user_id: audit.user_id,
        });
      } else {
        // Compatibility path for inventories opened before this migration.
        const movementNo = await reserveMovementNo(client);
        const movement = await client.query<{ id: string }>(
          `
            INSERT INTO public.stock_movements (
              movement_no, movement_type, status, article_id,
              stock_level_id, stock_batch_id, qty, currency,
              effective_at, posted_at, posted_by,
              source_document_type, source_document_id,
              reason_code, correlation_id, notes,
              user_id, created_by, updated_by
            )
            VALUES (
              $1,'ADJUSTMENT','POSTED',$2::uuid,$3::uuid,$4::uuid,$5,'EUR',
              now(),$6,$7,'stock_inventory_session',$8::uuid,'INVENTORY',$9::uuid,$10,$7,$7,$7
            )
            RETURNING id::text AS id
          `,
          [
            movementNo,
            adj.article_id,
            adj.stock_level_id,
            adj.stock_batch_id,
            delta,
            postedAt,
            audit.user_id,
            id,
            command.correlation_id,
            body.reason ?? `Inventaire ${s.session_no}`,
          ]
        );
        movementId = movement.rows[0]?.id ?? "";
        if (!movementId) throw new Error("Failed to create adjustment movement");
        await client.query(
          `
            INSERT INTO public.stock_movement_lines (
              movement_id, line_no, article_id, lot_id, qty, unite,
              src_magasin_id, src_emplacement_id,
              dst_magasin_id, dst_emplacement_id,
              direction, note, created_by, updated_by
            )
            VALUES ($1::uuid,1,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::bigint,$8::uuid,$9::bigint,$10,$11,$12,$12)
          `,
          [
            movementId,
            adj.article_id,
            adj.lot_id ?? null,
            Math.abs(delta),
            adj.unit_code,
            direction === "OUT" ? adj.magasin_id : null,
            direction === "OUT" ? adj.emplacement_id : null,
            direction === "IN" ? adj.magasin_id : null,
            direction === "IN" ? adj.emplacement_id : null,
            direction,
            adj.note ?? adj.reason_code ?? body.reason ?? null,
            audit.user_id,
          ]
        );
        await insertMovementEvent(client, {
          movement_id: movementId,
          event_type: "CREATED_POSTED",
          old_values: null,
          new_values: {
            status: "POSTED",
            movement_type: "ADJUSTMENT",
            delta,
            inventory_session_id: id,
            snapshot_line_id: adj.snapshot_line_id,
            theoretical_qty: adj.theoretical_qty,
            counted_qty: adj.counted_qty,
            correlation_id: command.correlation_id,
          },
          user_id: audit.user_id,
        });
        await client.query(
          `
            INSERT INTO public.stock_inventory_session_movements (
              session_id, stock_movement_id, snapshot_line_id
            )
            VALUES ($1::uuid,$2::uuid,$3::uuid)
            ON CONFLICT DO NOTHING
          `,
          [id, movementId, adj.snapshot_line_id]
        );
      }
      physicalAdjustmentIds.set(adj.snapshot_line_id,movementId);
    }

    for (const [snapshotId, physicalCount] of physicalCounts)
      await applyMaterialBarCountTx(client,physicalCount,physicalAdjustmentIds.get(snapshotId) ?? null,audit.user_id);

    for (const draft of drafts.rows) {
      if (postedDraftIds.has(draft.id)) continue;
      await client.query(
        `
          UPDATE public.stock_movements
          SET status = 'CANCELLED', correlation_id = $2::uuid,
              updated_at = now(), updated_by = $3
          WHERE id = $1::uuid
        `,
        [draft.id, command.correlation_id, audit.user_id]
      );
      await insertMovementEvent(client, {
        movement_id: draft.id,
        event_type: "CANCELLED",
        old_values: { status: "DRAFT", qty: draft.qty },
        new_values: { status: "CANCELLED", reason: "INVENTORY_NO_FINAL_DISCREPANCY" },
        user_id: audit.user_id,
      });
    }

    await client.query(
      `
        UPDATE public.stock_inventory_sessions
        SET
          status = 'CLOSED',
          closed_at = now(),
          closed_by = $2,
          row_version = row_version + 1,
          correlation_id = $3::uuid,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::uuid
      `,
      [id, audit.user_id, command.correlation_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.inventory_sessions.close",
      entity_type: "stock_inventory_sessions",
      entity_id: id,
      details: {
        session_no: s.session_no,
        adjustments_count: adjustments.length,
        reason: body.reason ?? null,
        correlation_id: command.correlation_id,
      },
    });

    await completeStockCommand(client, {
      audit,
      command,
      command_type: "INVENTORY_CLOSE",
      resource_type: "stock_inventory_session",
      resource_id: id,
      result_payload: {
        inventory_session_id: id,
        status: "CLOSED",
        adjustments_count: adjustments.length,
      },
    });

    await client.query("COMMIT");
    return repoGetInventorySession(id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
