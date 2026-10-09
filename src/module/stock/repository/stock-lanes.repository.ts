import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import {
  STOCK_LANES, STOCK_LANE_LABELS, STOCK_LANE_BLOCKER_MESSAGES,
  stockLaneConfigurationBlockers, type StockLane,
} from "../domain/stock-lanes";
import type { StockLaneLocation, StockLanePosition } from "../types/stock-lanes.types";
import type { StockLaneConfigurationCommand, StockLanePositionsQuery } from "../validators/stock-lanes.validators";

type Db = Pick<PoolClient, "query">;
type LocationRow = {
  location_id: string; emplacement_id: number; emplacement_code: string;
  magasin_id: string; magasin_code: string; lane: StockLane | null; version: number;
  active: boolean; mapped: boolean; storage: boolean; inbound: boolean; outbound: boolean;
  has_stock: boolean; has_reservations: boolean; has_delivery_or_assembly_reservations: boolean;
};

export async function assertStockLaneSchema(tx: Db): Promise<void> {
  const result = await tx.query<{ installed: boolean }>(
    `SELECT to_regclass('public.stock_lane_locations') IS NOT NULL
      AND to_regclass('public.stock_lane_configuration_events') IS NOT NULL
      AND to_regclass('public.v_stock_lane_positions_1028') IS NOT NULL AS installed`,
  );
  if (!result.rows[0]?.installed)
    throw new HttpError(409, "STOCK_LANES_NOT_INSTALLED", "Le paramétrage des pistes nécessite la mise à jour du socle stock.");
}

const LOCATION_SELECT = `SELECT e.location_id::text AS location_id, e.id::int AS emplacement_id,
  e.code AS emplacement_code, m.id::text AS magasin_id, m.code AS magasin_code,
  role.lane, COALESCE(role.row_version,0)::int AS version,
  (e.is_active AND m.is_active) AS active,
  (location.id IS NOT NULL AND location.warehouse_id IS NOT NULL) AS mapped,
  (e.location_type='STORAGE' AND NOT e.is_scrap) AS storage,
  e.allow_inbound AS inbound, e.allow_outbound AS outbound,
  EXISTS(SELECT 1 FROM public.stock_levels sl WHERE sl.location_id=e.location_id
    AND (sl.qty_total<>0 OR sl.qty_reserved<>0)) AS has_stock,
  EXISTS(SELECT 1 FROM public.stock_reservations r WHERE r.location_id=e.location_id
    AND r.status='ACTIVE' AND r.qty_reserved>COALESCE(r.qty_consumed,0)) AS has_reservations,
  EXISTS(SELECT 1 FROM public.stock_reservations r WHERE r.location_id=e.location_id
    AND r.status='ACTIVE' AND r.qty_reserved>COALESCE(r.qty_consumed,0)
    AND (r.livraison_affaire_id IS NOT NULL OR r.of_component_requirement_id IS NOT NULL
      OR r.source_type IN ('COMMANDE_LIGNE','AFFAIRE','BON_LIVRAISON_LIGNE','OF_COMPONENT')))
    AS has_delivery_or_assembly_reservations
  FROM public.emplacements e JOIN public.magasins m ON m.id=e.magasin_id
  LEFT JOIN public.locations location ON location.id=e.location_id
  LEFT JOIN public.stock_lane_locations role ON role.location_id=e.location_id`;

function mapLocation(row: LocationRow): StockLaneLocation {
  const facts = { active: row.active, mapped: row.mapped, storage: row.storage,
    inbound: row.inbound, outbound: row.outbound, previousLane: row.lane,
    hasStock: row.has_stock, hasReservations: row.has_reservations,
    hasDeliveryOrAssemblyReservations: row.has_delivery_or_assembly_reservations };
  return { location_id: row.location_id, emplacement_id: row.emplacement_id,
    emplacement_code: row.emplacement_code, magasin_id: row.magasin_id, magasin_code: row.magasin_code,
    lane: row.lane, version: row.version, facts,
    choices: STOCK_LANES.map(value => ({ value, label: STOCK_LANE_LABELS[value],
      blockers: stockLaneConfigurationBlockers(facts, value) })) };
}

export async function readStockLaneLocationsTx(tx: Db): Promise<StockLaneLocation[]> {
  await assertStockLaneSchema(tx);
  const rows = await tx.query<LocationRow>(`${LOCATION_SELECT}
    WHERE e.location_id IS NOT NULL ORDER BY m.code,e.code,e.id`);
  return rows.rows.map(mapLocation);
}

export async function readStockLanePositionsTx(tx: Db, query: StockLanePositionsQuery) {
  await assertStockLaneSchema(tx);
  const params = [query.lane ?? null, query.article_id ?? null, query.location_id ?? null,
    query.q?.trim() ? `%${query.q.trim().replace(/[\\%_]/g, "\\$&")}%` : null];
  const filter = `WHERE ($1::text IS NULL OR COALESCE(lane,'UNASSIGNED')=$1)
    AND ($2::uuid IS NULL OR article_id=$2::uuid)
    AND ($3::uuid IS NULL OR location_id=$3::uuid)
    AND ($4::text IS NULL OR article_code ILIKE $4 OR designation ILIKE $4 OR lot_code ILIKE $4)`;
  const total = (await tx.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM public.v_stock_lane_positions_1028 ${filter}`, params)).rows[0].total;
  const items = (await tx.query<StockLanePosition>(`SELECT position_id::text,stock_level_id::text,
    stock_batch_id::text,location_id::text,lane,magasin_code,emplacement_code,article_id::text,
    article_code,designation,unit,lot_id::text,lot_code,lot_status,source_scope,
    physical_qty::text,reserved_qty::text,delivery_reserved_qty::text,assembly_reserved_qty::text,
    other_reserved_qty::text,unreserved_qty::text,available_by_lot_status_qty::text,unexplained_reserved_qty::text
    FROM public.v_stock_lane_positions_1028 ${filter}
    ORDER BY article_code,magasin_code,emplacement_code,lot_code,position_id
    LIMIT $5 OFFSET $6`, [...params, query.page_size, (query.page - 1) * query.page_size])).rows;
  return { items, total, page: query.page, page_size: query.page_size };
}

/** All writes configure topology only; stock and reservations are never edited here. */
export async function configureStockLane(locationId: string, command: StockLaneConfigurationCommand, actor: number) {
  const tx = await pool.connect();
  return withRealtimeOutboxTransaction(tx, async client => {
    await assertStockLaneSchema(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`stock-lane:${locationId}`]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`stock-lane-command:${actor}:${command.request_id}`]);
    const hash = createHash("sha256").update(JSON.stringify({ locationId, actor, ...command })).digest("hex");
    const prior = (await client.query<{ request_hash: string; result_payload: unknown }>(
      `SELECT request_hash,result_payload FROM public.stock_lane_configuration_events
       WHERE actor_user_id=$1 AND request_id=$2::uuid`, [actor, command.request_id])).rows[0];
    if (prior) {
      if (prior.request_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette confirmation correspond à un autre paramétrage.");
      return { result: prior.result_payload, replayed: true };
    }
    // Lock the physical mapping and canonical balances before classifying an occupied zone.
    const identity = (await client.query<{ id: number; magasin_id: string }>(
      "SELECT id::int,magasin_id::text FROM public.emplacements WHERE location_id=$1::uuid FOR UPDATE", [locationId])).rows[0];
    if (!identity) throw new HttpError(404, "LOCATION_NOT_FOUND", "Emplacement de stock introuvable.");
    await client.query("SELECT id FROM public.magasins WHERE id=$1::uuid FOR SHARE", [identity.magasin_id]);
    await client.query("SELECT id FROM public.locations WHERE id=$1::uuid FOR UPDATE", [locationId]);
    await client.query("SELECT id FROM public.stock_levels WHERE location_id=$1::uuid ORDER BY id FOR UPDATE", [locationId]);
    const row = (await client.query<LocationRow>(`${LOCATION_SELECT} WHERE e.location_id=$1::uuid`, [locationId])).rows[0];
    const current = mapLocation(row);
    if (current.version !== command.expected_version)
      throw new HttpError(409, "STOCK_LANE_VERSION_CHANGED", "Le paramétrage a changé. Actualisez cet emplacement.");
    const blockers = stockLaneConfigurationBlockers(current.facts, command.lane);
    if (blockers.length) throw new HttpError(409, blockers[0], STOCK_LANE_BLOCKER_MESSAGES[blockers[0]], { blockers });
    const configured = (await client.query<{ version: number }>(`INSERT INTO public.stock_lane_locations
      (location_id,lane,row_version,updated_by) VALUES($1::uuid,$2,1,$3)
      ON CONFLICT(location_id) DO UPDATE SET lane=excluded.lane,
      row_version=stock_lane_locations.row_version+1,updated_by=excluded.updated_by,updated_at=now()
      RETURNING row_version::int AS version`, [locationId, command.lane, actor])).rows[0];
    const result = { location_id: locationId, lane: command.lane, version: configured.version };
    await client.query(`INSERT INTO public.stock_lane_configuration_events
      (location_id,request_id,request_hash,actor_user_id,reason,old_lane,new_lane,old_version,new_version,result_payload)
      VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [locationId, command.request_id, hash, actor, command.reason, current.lane, command.lane,
        current.version, result.version, JSON.stringify(result)]);
    await repoInsertAuditLog({ user_id: actor, tx: client, ip: null, user_agent: null,
      device_type: null, os: null, browser: null, body: { event_type: "ACTION",
        action: "STOCK_LANE_CONFIGURED", page_key: "stock", entity_type: "stock_lane_location",
        entity_id: locationId, details: { ...result, previous_lane: current.lane, reason: command.reason,
          request_id: command.request_id } } });
    return { result, replayed: false };
  });
}
