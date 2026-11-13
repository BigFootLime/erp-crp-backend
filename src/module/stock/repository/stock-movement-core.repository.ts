import type { PoolClient } from "pg";
import crypto from "node:crypto";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import { assertOperationalLotQualityEligibility, recordDirectLotQualityConsumption } from "../../qualite/repository/quality-operational-gate.repository";
import { assertPieceReceiptMovement } from "../../receptions/repository/receipt-processing-guard";
import { recordMaterialConsumptionOnPost } from "../../traceability/services/material-consumption.automation";
import { assertStockEntrySource } from "../domain/manual-entry-policy";
import { calculateStockAvailability, evaluateNegativeStockOverride, type NegativeStockOverride, type StockLotQualityStatus } from "../domain/stock-availability";
import { hashStockCommand, normalizeIdempotencyKey } from "../domain/stock-command";
import { resolveArticleStockUnit } from "../../../shared/stock-unit.repository";
import type { StockDocument, StockMovementDetail, StockMovementEvent, StockMovementLineDetail } from "../types/stock.types";
import type { CreateMovementBodyDTO, CreateMovementLineDTO, PostMovementBodyDTO, StockMovementTypeDTO } from "../validators/stock.validators";
import { consumableWithdrawalOwnsMovement } from "./consumable-movement-guard";
import { assemblyComponentWithdrawalOwnsMovement } from "./assembly-component-movement-guard";
import { lockMaterialBarPostingScopeTx, prepareMaterialBarPostingTx, applyMaterialBarPostingTx } from "./material-bar-posting.repository";
import type { MaterialBarPostingOwner } from "./material-bar-posting-owner";

type MovementRow = StockMovementDetail["movement"];



export type AuditContext = {
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};



export type StockCommandType =
  | "MOVEMENT_CREATE"
  | "MOVEMENT_POST"
  | "MOVEMENT_CANCEL"
  | "MOVEMENT_COMPENSATE"
  | "RESERVATION_CREATE"
  | "RESERVATION_RELEASE"
  | "RESERVATION_CONSUME"
  | "LOT_QUALITY_CHANGE"
  | "LOT_GENEALOGY_RECORD"
  | "INVENTORY_CREATE"
  | "INVENTORY_START"
  | "INVENTORY_COUNT"
  | "INVENTORY_APPROVE"
  | "INVENTORY_CANCEL"
  | "INVENTORY_CLOSE";



export type StockCommandReceipt = {
  request_hash: string;
  resource_type: string;
  resource_id: string;
  result_payload: Record<string, unknown>;
  correlation_id: string;
};



export type BegunStockCommand = {
  key: string;
  request_hash: string;
  request_payload: unknown;
  correlation_id: string;
  existing: StockCommandReceipt | null;
};



export async function beginStockCommand(
  client: Pick<PoolClient, "query">,
  args: {
    audit: AuditContext;
    idempotency_key: string;
    command_type: StockCommandType;
    request_payload: unknown;
  }
): Promise<BegunStockCommand> {
  const key = normalizeIdempotencyKey(args.idempotency_key);
  const requestHash = hashStockCommand(args.command_type, args.request_payload);

  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`stock:${args.audit.user_id}:${key}`]
  );

  const receipt = await client.query<StockCommandReceipt>(
    `
      SELECT
        request_hash,
        resource_type,
        resource_id,
        result_payload,
        correlation_id::text AS correlation_id
      FROM public.stock_command_receipts
      WHERE actor_user_id = $1
        AND idempotency_key = $2
      LIMIT 1
    `,
    [args.audit.user_id, key]
  );
  const existing = receipt.rows[0] ?? null;
  if (existing && existing.request_hash !== requestHash) {
    throw new HttpError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used with a different stock command"
    );
  }

  return {
    key,
    request_hash: requestHash,
    request_payload: args.request_payload,
    correlation_id: existing?.correlation_id ?? crypto.randomUUID(),
    existing,
  };
}



export async function completeStockCommand(
  client: Pick<PoolClient, "query">,
  args: {
    audit: AuditContext;
    command: BegunStockCommand;
    command_type: StockCommandType;
    resource_type: string;
    resource_id: string;
    result_payload: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO public.stock_command_receipts (
        actor_user_id,
        idempotency_key,
        request_hash,
        command_type,
        resource_type,
        resource_id,
        request_payload,
        result_payload,
        correlation_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::uuid)
      ON CONFLICT (actor_user_id, idempotency_key) DO NOTHING
    `,
    [
      args.audit.user_id,
      args.command.key,
      args.command.request_hash,
      args.command_type,
      args.resource_type,
      args.resource_id,
      JSON.stringify(args.command.request_payload),
      JSON.stringify(args.result_payload),
      args.command.correlation_id,
    ]
  );
}



export function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505";
}



export async function insertAuditLog(
  tx: Pick<PoolClient, "query">,
  audit: AuditContext,
  entry: {
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    details?: Record<string, unknown> | null;
  }
) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: entry.details ?? null,
  };

  await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}



async function getArticleStockSettings(client: Pick<PoolClient, "query">, articleId: string) {
  const res = await client.query<{ stock_managed: boolean; lot_tracking: boolean }>(
    `SELECT stock_managed, lot_tracking FROM public.articles WHERE id = $1::uuid LIMIT 1`,
    [articleId]
  );
  const row = res.rows[0] ?? null;
  if (!row) {
    throw new HttpError(400, "INVALID_ARTICLE", "Unknown article_id");
  }
  return row;
}



export async function ensureArticleStockManaged(client: Pick<PoolClient, "query">, articleId: string) {
  const row = await getArticleStockSettings(client, articleId);
  if (!row.stock_managed) {
    throw new HttpError(409, "ARTICLE_NOT_STOCK_MANAGED", "This article is not managed in stock and cannot be used in stock movements");
  }
}



export async function ensureLotTrackingRespected(client: Pick<PoolClient, "query">, articleId: string, lines: CreateMovementLineDTO[]) {
  const row = await getArticleStockSettings(client, articleId);
  if (!row.lot_tracking) return;
  const missingLot = lines.some((line) => !line.lot_id);
  if (missingLot) {
    throw new HttpError(409, "LOT_REQUIRED", "This article is lot-tracked and requires lot_id on every movement line");
  }
}



function movementNoFromSeq(n: number): string {
  const padded = String(n).padStart(8, "0");
  return `SM-${padded}`;
}



export async function reserveMovementNo(client: Pick<PoolClient, "query">): Promise<string> {
  const res = await client.query<{ n: string }>(`SELECT nextval('public.stock_movement_no_seq')::text AS n`);
  const raw = res.rows[0]?.n;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new Error("Failed to reserve stock movement number");
  return movementNoFromSeq(n);
}



function parseEffectiveAt(raw: string | null | undefined): Date {
  if (!raw) return new Date();
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) {
    throw new HttpError(400, "INVALID_EFFECTIVE_AT", "Invalid effective_at");
  }
  return dt;
}



export async function resolveUnitIdForArticle(
  client: Pick<PoolClient, "query">,
  articleId: string,
  preferredUnitCode: string | null | undefined
): Promise<string> {
  return (
    await resolveArticleStockUnit(client, articleId, preferredUnitCode, {
      missingUnit: { defaultCode: "u" },
      unknownUnitError: ({ submitted }) => new HttpError(400, "UNKNOWN_UNIT", `Unknown unit code: ${submitted}`),
    })
  ).unit_id;
}



export type EmplacementMapping = {
  magasin_id: string;
  location_id: string;
  warehouse_id: string;
  location_type: string;
  restrictions: Record<string, unknown>;
};



export async function getEmplacementMapping(
  client: Pick<PoolClient, "query">,
  magasinId: string,
  emplacementId: number,
  label: "src" | "dst"
): Promise<EmplacementMapping> {
  const res = await client.query<{
    magasin_id: string;
    location_id: string | null;
    warehouse_id: string | null;
    emplacement_active: boolean;
    magasin_active: boolean;
    location_type: string;
    allow_inbound: boolean;
    allow_outbound: boolean;
    restrictions: Record<string, unknown>;
  }>(
    `
      SELECT
        e.magasin_id::text AS magasin_id,
        e.location_id::text AS location_id,
        l.warehouse_id::text AS warehouse_id,
        e.is_active AS emplacement_active,
        m.is_active AS magasin_active,
        e.location_type,
        e.allow_inbound,
        e.allow_outbound,
        e.restrictions
      FROM public.emplacements e
      JOIN public.magasins m ON m.id = e.magasin_id
      LEFT JOIN public.locations l ON l.id = e.location_id
      WHERE e.id = $1::bigint
    `,
    [emplacementId]
  );

  const row = res.rows[0] ?? null;
  if (!row) {
    throw new HttpError(400, "INVALID_LOCATION", `Unknown ${label}_emplacement_id`);
  }
  if (row.magasin_id !== magasinId) {
    throw new HttpError(400, "INVALID_LOCATION", `${label}_emplacement_id does not belong to ${label}_magasin_id`);
  }
  if (!row.emplacement_active || !row.magasin_active) {
    throw new HttpError(409, "LOCATION_INACTIVE", `${label} magasin or emplacement is inactive`);
  }
  if (!row.location_id || !row.warehouse_id) {
    throw new HttpError(409, "LOCATION_NOT_MAPPED", `Emplacement is missing ${label} location mapping`);
  }
  if (label === "src" && !row.allow_outbound) {
    throw new HttpError(409, "LOCATION_INCOMPATIBLE", "Source emplacement does not allow outbound stock");
  }
  if (label === "dst" && !row.allow_inbound) {
    throw new HttpError(409, "LOCATION_INCOMPATIBLE", "Destination emplacement does not allow inbound stock");
  }

  return {
    magasin_id: row.magasin_id,
    location_id: row.location_id,
    warehouse_id: row.warehouse_id,
    location_type: row.location_type,
    restrictions: row.restrictions ?? {},
  };
}



export async function ensureStockLevel(
  client: Pick<PoolClient, "query">,
  args: {
    article_id: string;
    unit_id: string;
    warehouse_id: string;
    location_id: string;
    actor_user_id: number;
  }
): Promise<string> {
  const existing = await client.query<{
    id: string;
    unit_id: string;
    warehouse_id: string;
  }>(
    `
      SELECT
        id::text AS id,
        unit_id::text AS unit_id,
        warehouse_id::text AS warehouse_id
      FROM public.stock_levels
      WHERE article_id = $1::uuid AND location_id = $2::uuid
    `,
    [args.article_id, args.location_id]
  );

  const row = existing.rows[0] ?? null;
  if (row) {
    if (row.unit_id !== args.unit_id) {
      throw new HttpError(409, "STOCK_LEVEL_UNIT_MISMATCH", "Stock level unit mismatch");
    }
    if (row.warehouse_id !== args.warehouse_id) {
      throw new HttpError(409, "STOCK_LEVEL_WAREHOUSE_MISMATCH", "Stock level warehouse mismatch");
    }
    return row.id;
  }

  await client.query(
    `
      INSERT INTO public.stock_levels (
        article_id, unit_id, warehouse_id, location_id,
        managed_in_stock,
        created_by, updated_by
      )
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,true,$5,$5)
      ON CONFLICT (article_id, location_id) DO NOTHING
    `,
    [args.article_id, args.unit_id, args.warehouse_id, args.location_id, args.actor_user_id]
  );

  const after = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM public.stock_levels WHERE article_id = $1::uuid AND location_id = $2::uuid`,
    [args.article_id, args.location_id]
  );
  const id = after.rows[0]?.id;
  if (!id) throw new Error("Failed to ensure stock level");
  return id;
}



export async function ensureStockBatchId(
  client: Pick<PoolClient, "query">,
  args: {
    stock_level_id: string;
    lot_id: string;
  }
): Promise<string> {
  const lot = await client.query<{ lot_code: string }>(
    `
      SELECT lot.lot_code
      FROM public.lots lot
      JOIN public.stock_levels level
        ON level.id = $2::uuid
       AND level.article_id = lot.article_id
      WHERE lot.id = $1::uuid
    `,
    [args.lot_id, args.stock_level_id]
  );
  const lotCode = lot.rows[0]?.lot_code;
  if (!lotCode) {
    throw new HttpError(409, "LOT_ARTICLE_MISMATCH", "Lot does not belong to the movement article");
  }

  await client.query(
    `
      INSERT INTO public.stock_batches (stock_level_id, batch_code, lot_id)
      VALUES ($1::uuid,$2,$3::uuid)
      ON CONFLICT (stock_level_id, batch_code)
      DO UPDATE SET lot_id = COALESCE(public.stock_batches.lot_id, EXCLUDED.lot_id)
    `,
    [args.stock_level_id, lotCode, args.lot_id]
  );

  const b = await client.query<{ id: string }>(
    `
      SELECT id::text AS id
      FROM public.stock_batches
      WHERE stock_level_id = $1::uuid
        AND lot_id = $2::uuid
    `,
    [args.stock_level_id, args.lot_id]
  );
  const id = b.rows[0]?.id;
  if (!id) throw new Error("Failed to ensure stock batch");
  return id;
}



export type StockLockTarget = {
  stock_level_id: string;
  stock_batch_id: string | null;
};



export type LockedStockState = {
  stock_level_id: string;
  stock_batch_id: string | null;
  qty_on_hand: number;
  qty_reserved: number;
  qty_depreciated: number;
  lot_status: StockLotQualityStatus;
};



export function stockTargetKey(target: StockLockTarget): string {
  return `${target.stock_level_id}:${target.stock_batch_id ?? "-"}`;
}



export async function lockStockStates(
  client: Pick<PoolClient, "query">,
  targets: StockLockTarget[]
): Promise<Map<string, LockedStockState>> {
  const uniqueTargets = new Map<string, StockLockTarget>();
  for (const target of targets) uniqueTargets.set(stockTargetKey(target), target);

  const levelIds = [...new Set([...uniqueTargets.values()].map((target) => target.stock_level_id))].sort();
  const levelRows = new Map<
    string,
    { qty_total: number; qty_reserved: number; qty_depreciated: number }
  >();
  for (const levelId of levelIds) {
    const level = await client.query<{
      qty_total: number;
      qty_reserved: number;
      qty_depreciated: number;
    }>(
      `
        SELECT
          qty_total::float8 AS qty_total,
          qty_reserved::float8 AS qty_reserved,
          qty_depreciated::float8 AS qty_depreciated
        FROM public.stock_levels
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [levelId]
    );
    const row = level.rows[0] ?? null;
    if (!row) throw new HttpError(409, "STOCK_LEVEL_MISSING", "Stock level no longer exists");
    levelRows.set(levelId, row);
  }

  const batchIds = [
    ...new Set(
      [...uniqueTargets.values()]
        .map((target) => target.stock_batch_id)
        .filter((id): id is string => typeof id === "string")
    ),
  ].sort();
  const batchRows = new Map<
    string,
    {
      stock_level_id: string;
      lot_id: string | null;
      qty_total: number;
      qty_reserved: number;
      qty_depreciated: number;
    }
  >();
  for (const batchId of batchIds) {
    const batch = await client.query<{
      stock_level_id: string;
      lot_id: string | null;
      qty_total: number;
      qty_reserved: number;
      qty_depreciated: number;
    }>(
      `
        SELECT
          stock_level_id::text AS stock_level_id,
          lot_id::text AS lot_id,
          qty_total::float8 AS qty_total,
          qty_reserved::float8 AS qty_reserved,
          qty_depreciated::float8 AS qty_depreciated
        FROM public.stock_batches
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [batchId]
    );
    const row = batch.rows[0] ?? null;
    if (!row) throw new HttpError(409, "STOCK_BATCH_MISSING", "Stock batch no longer exists");
    batchRows.set(batchId, row);
  }

  const lotIds = [
    ...new Set(
      [...batchRows.values()]
        .map((batch) => batch.lot_id)
        .filter((id): id is string => typeof id === "string")
    ),
  ].sort();
  const lotStatuses = new Map<string, StockLotQualityStatus>();
  for (const lotId of lotIds) {
    const lot = await client.query<{ lot_status: StockLotQualityStatus }>(
      `SELECT lot_status FROM public.lots WHERE id = $1::uuid FOR SHARE`,
      [lotId]
    );
    const row = lot.rows[0] ?? null;
    if (!row) throw new HttpError(409, "LOT_MISSING", "Stock lot no longer exists");
    lotStatuses.set(lotId, row.lot_status ?? "LIBERE");
  }

  const states = new Map<string, LockedStockState>();
  for (const target of uniqueTargets.values()) {
    const level = levelRows.get(target.stock_level_id);
    if (!level) throw new Error("Locked stock level state missing");
    if (!target.stock_batch_id) {
      states.set(stockTargetKey(target), {
        stock_level_id: target.stock_level_id,
        stock_batch_id: null,
        qty_on_hand: Number(level.qty_total),
        qty_reserved: Number(level.qty_reserved),
        qty_depreciated: Number(level.qty_depreciated),
        lot_status: null,
      });
      continue;
    }

    const batch = batchRows.get(target.stock_batch_id);
    if (!batch || batch.stock_level_id !== target.stock_level_id) {
      throw new HttpError(409, "STOCK_BATCH_MISMATCH", "Stock batch does not belong to stock level");
    }
    states.set(stockTargetKey(target), {
      stock_level_id: target.stock_level_id,
      stock_batch_id: target.stock_batch_id,
      qty_on_hand: Number(batch.qty_total),
      qty_reserved: Number(batch.qty_reserved),
      qty_depreciated: Number(batch.qty_depreciated),
      lot_status: batch.lot_id ? lotStatuses.get(batch.lot_id) ?? null : null,
    });
  }
  return states;
}



export function assertStockConsumptionAllowed(
  state: LockedStockState,
  args: {
    movement_type: StockMovementTypeDTO;
    qty: number;
    allow_nonreleased_adjustment?: boolean;
    negative_stock_override?: NegativeStockOverride;
  }
): void {
  const qty = Math.abs(args.qty);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new HttpError(400, "INVALID_MOVEMENT", "Movement quantity must be positive");
  }

  const availability = calculateStockAvailability(state);
  const consumesAvailable =
    args.movement_type === "OUT" ||
    args.movement_type === "TRANSFER" ||
    args.movement_type === "RESERVE" ||
    args.movement_type === "SCRAP" ||
    args.movement_type === "DEPRECIATE" ||
    ((args.movement_type === "ADJUST" || args.movement_type === "ADJUSTMENT") && args.qty < 0);

  if (
    consumesAvailable &&
    state.lot_status !== null &&
    state.lot_status !== "LIBERE" &&
    args.movement_type !== "SCRAP" &&
    args.movement_type !== "DEPRECIATE" &&
    !(
      args.allow_nonreleased_adjustment &&
      (args.movement_type === "ADJUST" || args.movement_type === "ADJUSTMENT")
    )
  ) {
    throw new HttpError(
      409,
      "LOT_NOT_RELEASED",
      "Ce lot n’est pas libéré pour une consommation de stock. Ouvrez son contrôle qualité."
    );
  }

  if (args.movement_type === "UNRESERVE") {
    if (availability.qty_reserved + 1e-9 < qty) {
      throw new HttpError(409, "RESERVATION_UNDERFLOW", "Cannot release more stock than is reserved");
    }
    return;
  }

  const consumableQty =
    args.movement_type === "SCRAP" || args.movement_type === "DEPRECIATE"
      ? Math.max(
          availability.qty_on_hand - availability.qty_reserved - availability.qty_depreciated,
          0
        )
      : args.allow_nonreleased_adjustment &&
          (args.movement_type === "ADJUST" || args.movement_type === "ADJUSTMENT")
        ? Math.max(
            availability.qty_on_hand - availability.qty_reserved - availability.qty_depreciated,
            0
          )
      : availability.qty_available;

  if (consumesAvailable && consumableQty + 1e-9 < qty) {
    if (args.negative_stock_override) {
      const override = evaluateNegativeStockOverride(
        state,
        qty,
        args.negative_stock_override
      );
      if (override.allowed) return;
      throw new HttpError(
        409,
        "NEGATIVE_STOCK_OVERRIDE_REFUSED",
        "Negative-stock override does not satisfy the approved policy",
        {
          override_code: override.code,
          projected_qty_on_hand: override.projected_qty_on_hand,
        }
      );
    }
    throw new HttpError(409, "INSUFFICIENT_STOCK", "Insufficient available stock for this movement");
  }
}



export function sumQty(lines: CreateMovementLineDTO[]): number {
  return lines.reduce((acc, l) => acc + (typeof l.qty === "number" ? l.qty : 0), 0);
}



export function assertSameArticle(lines: CreateMovementLineDTO[]) {
  const first = lines[0]?.article_id;
  if (!first) throw new HttpError(400, "INVALID_MOVEMENT", "Missing article_id");
  for (const l of lines) {
    if (l.article_id !== first) {
      throw new HttpError(400, "INVALID_MOVEMENT", "All movement lines must have the same article_id");
    }
  }
}



export function assertSameLotIfSet(lines: CreateMovementLineDTO[]): string | null {
  const firstLot = lines[0]?.lot_id ?? null;
  for (const l of lines) {
    const lot = l.lot_id ?? null;
    if (lot !== firstLot) {
      throw new HttpError(
        409,
        "MULTIPLE_LOTS_UNSUPPORTED",
        "One stock movement header can reference only one lot"
      );
    }
  }
  return firstLot;
}



type MovementLocationKey = {
  direction: "IN" | "OUT" | null;
  src_magasin_id: string | null;
  src_emplacement_id: number | null;
  dst_magasin_id: string | null;
  dst_emplacement_id: number | null;
};



function movementLocationKey(lines: CreateMovementLineDTO[], movementType: StockMovementTypeDTO): MovementLocationKey {
  const first = lines[0];
  if (!first) throw new HttpError(400, "INVALID_MOVEMENT", "Missing movement lines");

  if (movementType === "ADJUST" || movementType === "ADJUSTMENT") {
    const dir = first.direction ?? null;
    if (dir !== "IN" && dir !== "OUT") {
      throw new HttpError(400, "INVALID_MOVEMENT", "ADJUSTMENT movement requires direction");
    }
    for (const l of lines) {
      if (l.direction !== dir) {
        throw new HttpError(400, "INVALID_MOVEMENT", "All ADJUSTMENT lines must share the same direction");
      }
    }
    return {
      direction: dir,
      src_magasin_id: first.src_magasin_id ?? null,
      src_emplacement_id: first.src_emplacement_id ?? null,
      dst_magasin_id: first.dst_magasin_id ?? null,
      dst_emplacement_id: first.dst_emplacement_id ?? null,
    };
  }

  return {
    direction: null,
    src_magasin_id: first.src_magasin_id ?? null,
    src_emplacement_id: first.src_emplacement_id ?? null,
    dst_magasin_id: first.dst_magasin_id ?? null,
    dst_emplacement_id: first.dst_emplacement_id ?? null,
  };
}



export function assertConsistentLocations(lines: CreateMovementLineDTO[], movementType: StockMovementTypeDTO) {
  const first = movementLocationKey(lines, movementType);
  for (const l of lines) {
    const cur: MovementLocationKey =
      movementType === "ADJUST" || movementType === "ADJUSTMENT"
        ? {
            direction: l.direction ?? null,
            src_magasin_id: l.src_magasin_id ?? null,
            src_emplacement_id: l.src_emplacement_id ?? null,
            dst_magasin_id: l.dst_magasin_id ?? null,
            dst_emplacement_id: l.dst_emplacement_id ?? null,
          }
        : {
            direction: null,
            src_magasin_id: l.src_magasin_id ?? null,
            src_emplacement_id: l.src_emplacement_id ?? null,
            dst_magasin_id: l.dst_magasin_id ?? null,
            dst_emplacement_id: l.dst_emplacement_id ?? null,
          };

    if (movementType === "IN") {
      if (cur.dst_magasin_id !== first.dst_magasin_id || cur.dst_emplacement_id !== first.dst_emplacement_id) {
        throw new HttpError(400, "INVALID_MOVEMENT", "All IN lines must share the same destination location");
      }
    } else if (movementType === "OUT" || movementType === "RESERVE" || movementType === "UNRESERVE" || movementType === "DEPRECIATE" || movementType === "SCRAP") {
      if (cur.src_magasin_id !== first.src_magasin_id || cur.src_emplacement_id !== first.src_emplacement_id) {
        throw new HttpError(400, "INVALID_MOVEMENT", `All ${movementType} lines must share the same source location`);
      }
    } else if (movementType === "TRANSFER") {
      if (
        cur.src_magasin_id !== first.src_magasin_id ||
        cur.src_emplacement_id !== first.src_emplacement_id ||
        cur.dst_magasin_id !== first.dst_magasin_id ||
        cur.dst_emplacement_id !== first.dst_emplacement_id
      ) {
        throw new HttpError(400, "INVALID_MOVEMENT", "All TRANSFER lines must share the same source and destination locations");
      }
    } else if (movementType === "ADJUST" || movementType === "ADJUSTMENT") {
      if (cur.direction !== first.direction) {
        throw new HttpError(400, "INVALID_MOVEMENT", "All ADJUSTMENT lines must share the same direction");
      }
      if (first.direction === "IN") {
        if (cur.dst_magasin_id !== first.dst_magasin_id || cur.dst_emplacement_id !== first.dst_emplacement_id) {
          throw new HttpError(400, "INVALID_MOVEMENT", "All ADJUSTMENT IN lines must share the same destination location");
        }
      } else {
        if (cur.src_magasin_id !== first.src_magasin_id || cur.src_emplacement_id !== first.src_emplacement_id) {
          throw new HttpError(400, "INVALID_MOVEMENT", "All ADJUSTMENT OUT lines must share the same source location");
        }
      }
    }
  }
}



export async function insertMovementEvent(
  client: Pick<PoolClient, "query">,
  args: {
    movement_id: string;
    event_type: string;
    old_values: unknown | null;
    new_values: unknown | null;
    user_id: number;
  }
) {
  await client.query(
    `
      INSERT INTO public.stock_movement_event_log (
        stock_movement_id, event_type, old_values, new_values,
        user_id,
        created_by, updated_by
      )
      VALUES ($1::uuid,$2,$3::jsonb,$4::jsonb,$5,$5,$5)
    `,
    [args.movement_id, args.event_type, JSON.stringify(args.old_values), JSON.stringify(args.new_values), args.user_id]
  );
}



export async function repoGetMovement(id: string, tx: Pick<PoolClient, "query"> = db): Promise<StockMovementDetail | null> {
  const m = await tx.query<MovementRow>(
    `
      SELECT
        id::text AS id,
        movement_no,
        movement_type::text AS movement_type,
        status,
        article_id::text AS article_id,
        stock_level_id::text AS stock_level_id,
        stock_batch_id::text AS stock_batch_id,
        qty::float8 AS qty,
        effective_at::text AS effective_at,
        posted_at::text AS posted_at,
        source_document_type,
        source_document_id,
        reason_code,
        correlation_id::text AS correlation_id,
        reversal_of_id::text AS reversal_of_id,
        notes,
        created_at::text AS created_at,
        updated_at::text AS updated_at,
        created_by,
        updated_by,
        posted_by
      FROM public.stock_movements
      WHERE id = $1::uuid
    `,
    [id]
  );
  const movement = m.rows[0] ?? null;
  if (!movement) return null;

  const l = await tx.query<StockMovementLineDetail>(
    `
      SELECT
        l.id::text AS id,
        l.movement_id::text AS movement_id,
        l.line_no::int AS line_no,
        l.article_id::text AS article_id,
        a.code AS article_code,
        a.designation AS article_designation,
        l.lot_id::text AS lot_id,
        lot.lot_code AS lot_code,
        l.qty::float8 AS qty,
        l.unite,
        l.unit_cost::float8 AS unit_cost,
        l.currency,
        l.src_magasin_id::text AS src_magasin_id,
        COALESCE(sm.code, sm.code_magasin)::text AS src_magasin_code,
        COALESCE(sm.name, sm.libelle)::text AS src_magasin_name,
        l.src_emplacement_id::int AS src_emplacement_id,
        se.code AS src_emplacement_code,
        se.name AS src_emplacement_name,
        l.dst_magasin_id::text AS dst_magasin_id,
        COALESCE(dm.code, dm.code_magasin)::text AS dst_magasin_code,
        COALESCE(dm.name, dm.libelle)::text AS dst_magasin_name,
        l.dst_emplacement_id::int AS dst_emplacement_id,
        de.code AS dst_emplacement_code,
        de.name AS dst_emplacement_name,
        l.note,
        l.direction
      FROM public.stock_movement_lines l
      JOIN public.articles a ON a.id = l.article_id
      LEFT JOIN public.lots lot ON lot.id = l.lot_id
      LEFT JOIN public.magasins sm ON sm.id = l.src_magasin_id
      LEFT JOIN public.emplacements se ON se.id = l.src_emplacement_id
      LEFT JOIN public.magasins dm ON dm.id = l.dst_magasin_id
      LEFT JOIN public.emplacements de ON de.id = l.dst_emplacement_id
      WHERE l.movement_id = $1::uuid
      ORDER BY l.line_no ASC, l.id ASC
    `,
    [id]
  );

  const docs = await tx.query<StockDocument>(
    `
      SELECT
        sd.id::text AS document_id,
        sd.original_name AS document_name,
        md.type
      FROM public.stock_movement_documents md
      JOIN public.stock_documents sd ON sd.id = md.document_id
      WHERE md.stock_movement_id = $1::uuid
        AND sd.removed_at IS NULL
      ORDER BY md.created_at DESC, md.id DESC
    `,
    [id]
  );

  const events = await tx.query<StockMovementEvent>(
    `
      SELECT
        id::text AS id,
        stock_movement_id::text AS stock_movement_id,
        event_type,
        old_values,
        new_values,
        user_id,
        created_at::text AS created_at
      FROM public.stock_movement_event_log
      WHERE stock_movement_id = $1::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT 200
    `,
    [id]
  );

  return {
    movement,
    lines: l.rows,
    documents: docs.rows,
    events: events.rows,
  };
}



export async function repoCreateMovement(
  body: CreateMovementBodyDTO,
  audit: AuditContext,
  options: { trusted_source_flow?: boolean; client?: PoolClient } = {}
): Promise<StockMovementDetail> {
  const client = options.client ?? await db.connect();
  const ownsTransaction = !options.client;
  try {
    if (ownsTransaction) await client.query("BEGIN");

    const { idempotency_key: _bodyIdempotencyKey, ...requestPayload } = body;
    const command = await beginStockCommand(client, {
      audit,
      idempotency_key: body.idempotency_key ?? "",
      command_type: "MOVEMENT_CREATE",
      request_payload: requestPayload,
    });
    if (command.existing) {
      const existingId = command.existing.resource_id;
      if (ownsTransaction) await client.query("COMMIT");
      const existing = await repoGetMovement(existingId, options.client);
      if (!existing) throw new Error("Idempotent movement receipt points to a missing movement");
      return existing;
    }

    assertStockEntrySource({ movementType: body.movement_type, trustedSource: options.trusted_source_flow });
    if (body.movement_type === "RESERVE" || body.movement_type === "UNRESERVE") {
      throw new HttpError(
        422,
        "USE_RESERVATION_API",
        "Reservations are non-physical allocations and must use the stock reservation API"
      );
    }
    const protectedSourceTypes = new Set([
      "OF",
      "PRODUCTION_RECEIPT",
      "URGENCY_RESTITUTION",
      "SUPPLIER_RECEIPT",
      "RECEPTION_FOURNISSEUR",
      "BON_LIVRAISON",
      "DELIVERY",
    ]);
    if (
      !options.trusted_source_flow &&
      body.source_document_type &&
      protectedSourceTypes.has(body.source_document_type.trim().toUpperCase())
    ) {
      throw new HttpError(
        422,
        "CANONICAL_SOURCE_FLOW_REQUIRED",
        "This stock source must be posted by its owning production, supplier-receipt or delivery service"
      );
    }

    assertSameArticle(body.lines);
    assertConsistentLocations(body.lines, body.movement_type);

    const movementNo = await reserveMovementNo(client);
    const effectiveAt = parseEffectiveAt(body.effective_at);
    const articleId = body.lines[0]?.article_id;
    if (!articleId) throw new HttpError(400, "INVALID_MOVEMENT", "Missing article_id");

    await ensureArticleStockManaged(client, articleId);
    await ensureLotTrackingRespected(client, articleId, body.lines);

    const unitId = await resolveUnitIdForArticle(client, articleId, body.lines[0]?.unite ?? null);

    let stockLevelId: string;
    let qtyForMovement: number;
    let direction: "IN" | "OUT" | null = null;

    const first = body.lines[0];
    if (!first) throw new HttpError(400, "INVALID_MOVEMENT", "Missing movement lines");

    const totalQty = sumQty(body.lines);
    if (!Number.isFinite(totalQty) || totalQty === 0) {
      throw new HttpError(400, "INVALID_MOVEMENT", "Invalid qty");
    }

    if (body.movement_type === "IN") {
      if (!first.dst_magasin_id || !first.dst_emplacement_id) {
        throw new HttpError(400, "INVALID_MOVEMENT", "IN requires destination location");
      }
      const map = await getEmplacementMapping(client, first.dst_magasin_id, first.dst_emplacement_id, "dst");
      stockLevelId = await ensureStockLevel(client, {
        article_id: articleId,
        unit_id: unitId,
        warehouse_id: map.warehouse_id,
        location_id: map.location_id,
        actor_user_id: audit.user_id,
      });
      qtyForMovement = totalQty;
    } else if (
      body.movement_type === "OUT" ||
      body.movement_type === "DEPRECIATE" ||
      body.movement_type === "SCRAP"
    ) {
      if (!first.src_magasin_id || !first.src_emplacement_id) {
        throw new HttpError(400, "INVALID_MOVEMENT", `${body.movement_type} requires source location`);
      }
      const map = await getEmplacementMapping(client, first.src_magasin_id, first.src_emplacement_id, "src");
      stockLevelId = await ensureStockLevel(client, {
        article_id: articleId,
        unit_id: unitId,
        warehouse_id: map.warehouse_id,
        location_id: map.location_id,
        actor_user_id: audit.user_id,
      });
      qtyForMovement = totalQty;
    } else if (body.movement_type === "TRANSFER") {
      if (!first.src_magasin_id || !first.src_emplacement_id || !first.dst_magasin_id || !first.dst_emplacement_id) {
        throw new HttpError(400, "INVALID_MOVEMENT", "TRANSFER requires source and destination locations");
      }
      const src = await getEmplacementMapping(client, first.src_magasin_id, first.src_emplacement_id, "src");
      await getEmplacementMapping(client, first.dst_magasin_id, first.dst_emplacement_id, "dst");

      stockLevelId = await ensureStockLevel(client, {
        article_id: articleId,
        unit_id: unitId,
        warehouse_id: src.warehouse_id,
        location_id: src.location_id,
        actor_user_id: audit.user_id,
      });
      qtyForMovement = totalQty;
    } else if (body.movement_type === "ADJUST" || body.movement_type === "ADJUSTMENT") {
      direction = first.direction ?? null;
      if (direction !== "IN" && direction !== "OUT") {
        throw new HttpError(400, "INVALID_MOVEMENT", "ADJUSTMENT requires direction");
      }
      if (direction === "IN") {
        if (!first.dst_magasin_id || !first.dst_emplacement_id) {
          throw new HttpError(400, "INVALID_MOVEMENT", "ADJUSTMENT IN requires destination location");
        }
        const dst = await getEmplacementMapping(client, first.dst_magasin_id, first.dst_emplacement_id, "dst");
        stockLevelId = await ensureStockLevel(client, {
          article_id: articleId,
          unit_id: unitId,
          warehouse_id: dst.warehouse_id,
          location_id: dst.location_id,
          actor_user_id: audit.user_id,
        });
        qtyForMovement = totalQty;
      } else {
        if (!first.src_magasin_id || !first.src_emplacement_id) {
          throw new HttpError(400, "INVALID_MOVEMENT", "ADJUSTMENT OUT requires source location");
        }
        const src = await getEmplacementMapping(client, first.src_magasin_id, first.src_emplacement_id, "src");
        stockLevelId = await ensureStockLevel(client, {
          article_id: articleId,
          unit_id: unitId,
          warehouse_id: src.warehouse_id,
          location_id: src.location_id,
          actor_user_id: audit.user_id,
        });
        qtyForMovement = -totalQty;
      }
    } else {
      throw new HttpError(400, "INVALID_MOVEMENT", "Unsupported movement type");
    }

    const uniformLotId = assertSameLotIfSet(body.lines);
    const stockBatchId = uniformLotId
      ? await ensureStockBatchId(client, { stock_level_id: stockLevelId, lot_id: uniformLotId })
      : null;

    const insertMovementSql = `
      INSERT INTO public.stock_movements (
        movement_no,
        movement_type,
        status,
        article_id,
        stock_level_id,
        stock_batch_id,
        qty,
        currency,
        effective_at,
        source_document_type,
        source_document_id,
        reason_code,
        notes,
        idempotency_key,
        correlation_id,
        user_id,
        created_by,
        updated_by
      )
      VALUES ($1,$2::public.movement_type,'DRAFT',$3::uuid,$4::uuid,$5::uuid,$6,'EUR',$7,$8,$9,$10,$11,$12,$13::uuid,$14,$14,$14)
      RETURNING id::text AS id
    `;

    let movementId: string;
    const storedIdempotencyKey = `${audit.user_id}:${command.key}`;
    try {
      const ins = await client.query<{ id: string }>(insertMovementSql, [
        movementNo,
        body.movement_type,
        articleId,
        stockLevelId,
        stockBatchId,
        qtyForMovement,
        effectiveAt.toISOString(),
        body.source_document_type ?? null,
        body.source_document_id ?? null,
        body.reason_code ?? null,
        body.notes ?? null,
        storedIdempotencyKey,
        command.correlation_id,
        audit.user_id,
      ]);
      movementId = ins.rows[0]?.id ?? "";
      if (!movementId) throw new Error("Failed to create movement");
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        const existing = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM public.stock_movements WHERE idempotency_key = $1`,
          [storedIdempotencyKey]
        );
        const id = existing.rows[0]?.id;
        if (!id) throw err;
        await completeStockCommand(client, {
          audit,
          command,
          command_type: "MOVEMENT_CREATE",
          resource_type: "stock_movement",
          resource_id: id,
          result_payload: {
            movement_id: id,
            status: "DRAFT",
            legacy_idempotency_recovery: true,
          },
        });
        if (ownsTransaction) await client.query("COMMIT");
        const out = await repoGetMovement(id, options.client);
        if (!out) throw new Error("Failed to read existing idempotent movement");
        return out;
      }
      throw err;
    }

    const linesToInsert = body.lines.map((l, i) => {
      const lineNo = typeof l.line_no === "number" ? l.line_no : i + 1;
      return { ...l, line_no: lineNo };
    });

    for (const line of linesToInsert) {
      if (line.src_magasin_id && line.src_emplacement_id) {
        await getEmplacementMapping(client, line.src_magasin_id, line.src_emplacement_id, "src");
      }
      if (line.dst_magasin_id && line.dst_emplacement_id) {
        await getEmplacementMapping(client, line.dst_magasin_id, line.dst_emplacement_id, "dst");
      }
      if (
        line.src_magasin_id &&
        line.src_emplacement_id &&
        line.dst_magasin_id &&
        line.dst_emplacement_id &&
        line.src_magasin_id === line.dst_magasin_id &&
        line.src_emplacement_id === line.dst_emplacement_id
      ) {
        throw new HttpError(400, "INVALID_LINE", "Source and destination cannot be the same location");
      }

      await client.query(
        `
          INSERT INTO public.stock_movement_lines (
            movement_id, line_no, article_id, lot_id,
            qty, unite, unit_cost, currency,
            src_magasin_id, src_emplacement_id,
            dst_magasin_id, dst_emplacement_id,
            note,
            direction,
            created_by, updated_by
          )
          VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7,$8,$9::uuid,$10::bigint,$11::uuid,$12::bigint,$13,$14,$15,$15)
        `,
        [
          movementId,
          line.line_no,
          line.article_id,
          line.lot_id ?? null,
          line.qty,
          line.unite ?? null,
          line.unit_cost ?? null,
          line.currency ?? null,
          line.src_magasin_id ?? null,
          line.src_emplacement_id ?? null,
          line.dst_magasin_id ?? null,
          line.dst_emplacement_id ?? null,
          line.note ?? null,
          line.direction ?? null,
          audit.user_id,
        ]
      );
    }

    await insertMovementEvent(client, {
      movement_id: movementId,
      event_type: "CREATED",
      old_values: null,
      new_values: {
        status: "DRAFT",
        movement_type: body.movement_type,
        lines_count: body.lines.length,
      },
      user_id: audit.user_id,
    });

    await insertAuditLog(client, audit, {
      action: "stock.movements.create",
      entity_type: "stock_movements",
      entity_id: movementId,
      details: {
        movement_no: movementNo,
        movement_type: body.movement_type,
        lines_count: body.lines.length,
        idempotency_key: body.idempotency_key ?? null,
        correlation_id: command.correlation_id,
      },
    });

    await completeStockCommand(client, {
      audit,
      command,
      command_type: "MOVEMENT_CREATE",
      resource_type: "stock_movement",
      resource_id: movementId,
      result_payload: {
        movement_id: movementId,
        movement_no: movementNo,
        status: "DRAFT",
      },
    });

    if (ownsTransaction) await client.query("COMMIT");
    const out = await repoGetMovement(movementId, options.client);
    if (!out) throw new Error("Failed to read created movement");
    return out;
  } catch (err) {
    if (ownsTransaction) await client.query("ROLLBACK");
    throw err;
  } finally {
    if (ownsTransaction) client.release();
  }
}



export async function assertDirectOutMovementQualityEligibility(params: {
  client: Pick<PoolClient, "query">;
  lines: Array<Pick<CreateMovementLineDTO, "lot_id" | "qty" | "unite">>;
}): Promise<Array<Awaited<ReturnType<typeof assertOperationalLotQualityEligibility>>>> {
  const quantitiesByLot = new Map<string, { qty: number; unit: string | null }>();
  for (const line of params.lines) {
    if (!line.lot_id) continue;
    const qty = Math.abs(Number(line.qty));
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new HttpError(422, "QUALITY_MOVEMENT_QTY_INVALID", "Quantité de sortie invalide pour le contrôle Qualité.");
    }
    const unit = line.unite?.trim().toUpperCase() || null;
    const existing = quantitiesByLot.get(line.lot_id);
    if (existing && (existing.unit ?? null) !== unit) {
      throw new HttpError(
        409,
        "QUALITY_MOVEMENT_UNIT_AMBIGUOUS",
        "Un même lot ne peut pas être sorti avec plusieurs unités dans un mouvement."
      );
    }
    quantitiesByLot.set(line.lot_id, { qty: (existing?.qty ?? 0) + qty, unit });
  }
  const decisions: Array<Awaited<ReturnType<typeof assertOperationalLotQualityEligibility>>> = [];
  for (const [lotId, input] of quantitiesByLot) {
    decisions.push(await assertOperationalLotQualityEligibility({
      client: params.client,
      lotId,
      qty: input.qty,
      unit: input.unit,
      purpose: "RESERVE",
    }));
  }
  return decisions;
}



export async function repoPostMovement(
  id: string,
  body: PostMovementBodyDTO,
  audit: AuditContext,
  idempotencyKey: string,
  externalClient?: PoolClient,
  reservedConsumption?: {reservationId:string},
  physicalBarOwner?: MaterialBarPostingOwner
): Promise<StockMovementDetail | null> {
  const client = externalClient ?? await db.connect();
  const ownsTransaction = !externalClient;
  try {
    if (ownsTransaction) await client.query("BEGIN");

    const command = await beginStockCommand(client, {
      audit,
      idempotency_key: idempotencyKey,
      command_type: "MOVEMENT_POST",
      request_payload: { movement_id: id, ...body },
    });
    if (command.existing) {
      const existingId = command.existing.resource_id;
      if (ownsTransaction) await client.query("COMMIT");
      return await repoGetMovement(existingId, externalClient);
    }

    const lock = await client.query<{
      id: string;
      status: string;
      movement_type: StockMovementTypeDTO;
      movement_no: string | null;
      effective_at: string;
      article_id: string;
      stock_level_id: string;
      stock_batch_id: string | null;
      qty: number;
      notes: string | null;
      reversal_of_id: string | null;
    }>(
      `
        SELECT
          id::text AS id,
          status,
          movement_type::text AS movement_type,
          movement_no,
          effective_at::text AS effective_at,
          article_id::text AS article_id,
          stock_level_id::text AS stock_level_id,
          stock_batch_id::text AS stock_batch_id,
          qty::float8 AS qty,
          notes,
          reversal_of_id::text AS reversal_of_id
        FROM public.stock_movements
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [id]
    );

    const m = lock.rows[0] ?? null;
    if (!m) {
      if (ownsTransaction) await client.query("ROLLBACK");
      return null;
    }
    if (m.status !== "DRAFT") {
      throw new HttpError(409, "INVALID_STATUS", "Only DRAFT movements can be posted");
    }
    assertStockEntrySource({ movementType: m.movement_type, trustedSource: Boolean(externalClient), reversalOfId: m.reversal_of_id });

    if(!externalClient){
      const reversal=(await client.query<{reversal_of_id:string|null}>('SELECT reversal_of_id::text FROM public.stock_movements WHERE id=$1::uuid',[id])).rows[0];
      if(reversal?.reversal_of_id&&await consumableWithdrawalOwnsMovement(client,reversal.reversal_of_id))throw new HttpError(409,'CONSUMABLE_WITHDRAWAL_CORRECTION_REQUIRED','La compensation de ce prélèvement doit partager la correction de la réservation consommée de l’OF.');
      if (reversal?.reversal_of_id && await assemblyComponentWithdrawalOwnsMovement(client, reversal.reversal_of_id)) throw new HttpError(409, 'ASSEMBLY_COMPONENT_CORRECTION_REQUIRED', 'La compensation doit partager la correction des composants et réservations de montage.');
      const materialReversal=(await client.query(`SELECT 1 FROM public.stock_movements m WHERE m.id=$1::uuid AND (
        EXISTS(SELECT 1 FROM public.production_material_debit_sources s WHERE s.stock_movement_id=m.reversal_of_id) OR
        EXISTS(SELECT 1 FROM public.production_material_remnants r WHERE r.stock_movement_id=m.reversal_of_id))`,[id])).rows.length>0;
      if(materialReversal)throw new HttpError(409,'MATERIAL_DEBIT_CORRECTION_REQUIRED','La compensation de ce mouvement doit partager la correction du débit matière de l’OF.');
    }

    await ensureArticleStockManaged(client, m.article_id);

    const draftLines = await client.query<CreateMovementLineDTO>(
      `
        SELECT
          line_no,
          article_id::text AS article_id,
          lot_id::text AS lot_id,
          qty::float8 AS qty,
          unite,
          unit_cost::float8 AS unit_cost,
          currency,
          src_magasin_id::text AS src_magasin_id,
          src_emplacement_id::int AS src_emplacement_id,
          dst_magasin_id::text AS dst_magasin_id,
          dst_emplacement_id::int AS dst_emplacement_id,
          note,
          direction
        FROM public.stock_movement_lines
        WHERE movement_id = $1::uuid
        ORDER BY line_no ASC
      `,
      [id]
    );
    await ensureLotTrackingRespected(client, m.article_id, draftLines.rows);
    await assertPieceReceiptMovement(client, id, m.movement_type, draftLines.rows);
    const barScope = await lockMaterialBarPostingScopeTx(client, { articleId: m.article_id,
      lotIds: draftLines.rows.flatMap(line => line.lot_id ? [line.lot_id] : []), explicit: !!body.material_bars || !!physicalBarOwner });
    if (physicalBarOwner?.kind === 'DEBIT' && !reservedConsumption)
      throw new HttpError(409, 'MATERIAL_BAR_POST_OWNER_INVALID', 'Le débit des barres doit consommer la réservation de son OF.');
    const physicalMovement = { id, batchId: m.stock_batch_id, type: m.movement_type, quantity: m.qty, reversalOf: m.reversal_of_id };

    // A direct material issue does not have to be created through a stock
    // reservation.  It is nevertheless an irreversible physical use of a
    // released lot, so it must pass the same Quality 360 boundary inside the
    // very transaction that posts the OUT movement.  Transfers merely change
    // location and quality dispositions (SCRAP/ADJUSTMENT) remain dedicated
    // workflows, so neither is treated as a released-material consumption.
    // Server-owned reservation consumption only. The caller has atomically
    // linked this exact movement and reduced physical reserved stock. An HTTP
    // request cannot supply this context or spend the quality release again.
    let reservedQualityDecision:Awaited<ReturnType<typeof assertOperationalLotQualityEligibility>>|null=null;
    if(reservedConsumption){
      if(!externalClient||m.movement_type!=='OUT'||draftLines.rows.length!==1)
        throw new HttpError(409,'RESERVED_MOVEMENT_CONTEXT_INVALID','La consommation réservée exige une transaction et une ligne de sortie uniques.');
      const line=draftLines.rows[0];
      const matching=(await client.query<{lot_id:string|null}>(`SELECT r.lot_id::text FROM public.stock_reservations r
        JOIN public.stock_movements mv ON mv.id=r.consumed_stock_movement_id
        WHERE r.id=$1::uuid AND mv.id=$2::uuid AND r.status IN ('ACTIVE','CONSUMED')
          AND r.article_id=mv.article_id AND r.stock_batch_id IS NOT DISTINCT FROM mv.stock_batch_id AND r.qty_consumed>=abs(mv.qty)
          AND r.lot_id IS NOT DISTINCT FROM $3::uuid AND mv.source_document_type='OF' AND mv.source_document_id=r.of_id::text
          AND abs(mv.qty)=$4 AND(r.expires_at IS NULL OR r.expires_at>now()) FOR SHARE OF r`,[reservedConsumption.reservationId,id,line.lot_id,Math.abs(Number(line.qty))])).rows[0];
      if(!matching)throw new HttpError(409,'RESERVED_MOVEMENT_MISMATCH','Le mouvement ne correspond pas à la consommation enregistrée sur cette réservation.');
      if(matching.lot_id)reservedQualityDecision=await assertOperationalLotQualityEligibility({client,lotId:matching.lot_id,qty:0,unit:line.unite,purpose:'RESERVE'});
    }
    const directOutQualityDecisions = m.movement_type === "OUT"&&!reservedConsumption
      ? await assertDirectOutMovementQualityEligibility({ client, lines: draftLines.rows })
      : [];

    if (m.movement_type === "TRANSFER") {
      const movementLines = draftLines.rows;
      if (!movementLines.length) {
        throw new HttpError(400, "INVALID_MOVEMENT", "TRANSFER movement has no lines");
      }

      assertSameArticle(movementLines);
        assertConsistentLocations(movementLines, "TRANSFER");

      const totalQty = sumQty(movementLines);
      if (!Number.isFinite(totalQty) || totalQty <= 0) {
        throw new HttpError(400, "INVALID_MOVEMENT", "Invalid TRANSFER qty");
      }

      const first = movementLines[0];
      if (!first?.src_magasin_id || !first.src_emplacement_id || !first.dst_magasin_id || !first.dst_emplacement_id) {
        throw new HttpError(400, "INVALID_MOVEMENT", "TRANSFER requires source and destination locations");
      }

      const unitId = await resolveUnitIdForArticle(client, m.article_id, first.unite ?? null);
      const srcMap = await getEmplacementMapping(client, first.src_magasin_id, first.src_emplacement_id, "src");
      const dstMap = await getEmplacementMapping(client, first.dst_magasin_id, first.dst_emplacement_id, "dst");

      const srcStockLevelId = await ensureStockLevel(client, {
        article_id: m.article_id,
        unit_id: unitId,
        warehouse_id: srcMap.warehouse_id,
        location_id: srcMap.location_id,
        actor_user_id: audit.user_id,
      });
      const dstStockLevelId = await ensureStockLevel(client, {
        article_id: m.article_id,
        unit_id: unitId,
        warehouse_id: dstMap.warehouse_id,
        location_id: dstMap.location_id,
        actor_user_id: audit.user_id,
      });

      const uniformLotId = assertSameLotIfSet(movementLines);
      const srcBatchId = uniformLotId ? await ensureStockBatchId(client, { stock_level_id: srcStockLevelId, lot_id: uniformLotId }) : null;
      const dstBatchId = uniformLotId ? await ensureStockBatchId(client, { stock_level_id: dstStockLevelId, lot_id: uniformLotId }) : null;

      const barMovement = await prepareMaterialBarPostingTx(client, { scope: barScope, movement: physicalMovement,
        destinationBatchId: dstBatchId, command: body.material_bars, owner: physicalBarOwner, externalTransaction: !!externalClient });

      const lockedStates = await lockStockStates(client, [
        { stock_level_id: srcStockLevelId, stock_batch_id: srcBatchId },
        { stock_level_id: dstStockLevelId, stock_batch_id: dstBatchId },
      ]);
      const sourceState = lockedStates.get(
        stockTargetKey({ stock_level_id: srcStockLevelId, stock_batch_id: srcBatchId })
      );
      if (!sourceState) throw new Error("Locked transfer source state missing");
      assertStockConsumptionAllowed(sourceState, {
        movement_type: "TRANSFER",
        qty: totalQty,
        negative_stock_override: body.negative_stock_override,
      });

      const postedAt = new Date().toISOString();
      const outMovementNo = await reserveMovementNo(client);
      const inMovementNo = await reserveMovementNo(client);

      const outMovement = await client.query<{ id: string }>(
        `
          INSERT INTO public.stock_movements (
            movement_no,
            movement_type,
            status,
            article_id,
            stock_level_id,
            stock_batch_id,
            qty,
            currency,
            effective_at,
            posted_at,
            posted_by,
            doc_type,
            doc_id,
            correlation_id,
            notes,
            user_id,
            created_by,
            updated_by
          )
          VALUES ($1,'OUT','POSTED',$2::uuid,$3::uuid,$4::uuid,$5,'EUR',$6,$7,$8,'STOCK_TRANSFER_INTERNAL',$9::uuid,$10::uuid,$11,$8,$8,$8)
          RETURNING id::text AS id
        `,
        [
          outMovementNo,
          m.article_id,
          srcStockLevelId,
          srcBatchId,
          totalQty,
          m.effective_at,
          postedAt,
          audit.user_id,
          id,
          command.correlation_id,
          m.notes ?? null,
        ]
      );
      const outMovementId = outMovement.rows[0]?.id;
      if (!outMovementId) throw new Error("Failed to create OUT transfer movement");

      const inMovement = await client.query<{ id: string }>(
        `
          INSERT INTO public.stock_movements (
            movement_no,
            movement_type,
            status,
            article_id,
            stock_level_id,
            stock_batch_id,
            qty,
            currency,
            effective_at,
            posted_at,
            posted_by,
            doc_type,
            doc_id,
            correlation_id,
            notes,
            user_id,
            created_by,
            updated_by
          )
          VALUES ($1,'IN','POSTED',$2::uuid,$3::uuid,$4::uuid,$5,'EUR',$6,$7,$8,'STOCK_TRANSFER_INTERNAL',$9::uuid,$10::uuid,$11,$8,$8,$8)
          RETURNING id::text AS id
        `,
        [
          inMovementNo,
          m.article_id,
          dstStockLevelId,
          dstBatchId,
          totalQty,
          m.effective_at,
          postedAt,
          audit.user_id,
          id,
          command.correlation_id,
          m.notes ?? null,
        ]
      );
      const inMovementId = inMovement.rows[0]?.id;
      if (!inMovementId) throw new Error("Failed to create IN transfer movement");

      for (const line of movementLines) {
        await client.query(
          `
            INSERT INTO public.stock_movement_lines (
              movement_id, line_no, article_id, lot_id,
              qty, unite, unit_cost, currency,
              src_magasin_id, src_emplacement_id,
              dst_magasin_id, dst_emplacement_id,
              note,
              direction,
              created_by, updated_by
            )
            VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7,$8,$9::uuid,$10::bigint,NULL,NULL,$11,NULL,$12,$12)
          `,
          [
            outMovementId,
            line.line_no,
            line.article_id,
            line.lot_id ?? null,
            line.qty,
            line.unite ?? null,
            line.unit_cost ?? null,
            line.currency ?? null,
            line.src_magasin_id,
            line.src_emplacement_id,
            line.note ?? null,
            audit.user_id,
          ]
        );

        await client.query(
          `
            INSERT INTO public.stock_movement_lines (
              movement_id, line_no, article_id, lot_id,
              qty, unite, unit_cost, currency,
              src_magasin_id, src_emplacement_id,
              dst_magasin_id, dst_emplacement_id,
              note,
              direction,
              created_by, updated_by
            )
            VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7,$8,NULL,NULL,$9::uuid,$10::bigint,$11,NULL,$12,$12)
          `,
          [
            inMovementId,
            line.line_no,
            line.article_id,
            line.lot_id ?? null,
            line.qty,
            line.unite ?? null,
            line.unit_cost ?? null,
            line.currency ?? null,
            line.dst_magasin_id,
            line.dst_emplacement_id,
            line.note ?? null,
            audit.user_id,
          ]
        );
      }

      await insertMovementEvent(client, {
        movement_id: outMovementId,
        event_type: "CREATED_POSTED",
        old_values: null,
        new_values: { status: "POSTED", movement_type: "OUT", doc_type: "STOCK_TRANSFER_INTERNAL", doc_id: id },
        user_id: audit.user_id,
      });
      await insertMovementEvent(client, {
        movement_id: inMovementId,
        event_type: "CREATED_POSTED",
        old_values: null,
        new_values: { status: "POSTED", movement_type: "IN", doc_type: "STOCK_TRANSFER_INTERNAL", doc_id: id },
        user_id: audit.user_id,
      });

      await client.query(
        `
          UPDATE public.stock_movements
          SET
            status = 'POSTED',
            posted_at = now(),
            posted_by = $2,
            correlation_id = $3::uuid,
            updated_at = now(),
            updated_by = $2
          WHERE id = $1::uuid
        `,
        [id, audit.user_id, command.correlation_id]
      );

      if (barMovement) await applyMaterialBarPostingTx(client, barMovement, audit.user_id);

      await insertMovementEvent(client, {
        movement_id: id,
        event_type: "POSTED",
        old_values: { status: "DRAFT" },
        new_values: { status: "POSTED" },
        user_id: audit.user_id,
      });

      await insertAuditLog(client, audit, {
        action: "stock.movements.post",
        entity_type: "stock_movements",
        entity_id: id,
        details: {
          movement_no: m.movement_no,
          movement_type: "TRANSFER",
          negative_stock_override: body.negative_stock_override
            ? {
                maximum_negative_qty:
                  body.negative_stock_override.maximum_negative_qty,
                reason: body.negative_stock_override.reason,
              }
            : null,
          legs: [
            { movement_id: outMovementId, movement_no: outMovementNo, movement_type: "OUT" },
            { movement_id: inMovementId, movement_no: inMovementNo, movement_type: "IN" },
          ],
        },
      });

      await completeStockCommand(client, {
        audit,
        command,
        command_type: "MOVEMENT_POST",
        resource_type: "stock_movement",
        resource_id: id,
        result_payload: {
          movement_id: id,
          status: "POSTED",
          movement_type: "TRANSFER",
          out_movement_id: outMovementId,
          in_movement_id: inMovementId,
        },
      });

      if (ownsTransaction) await client.query("COMMIT");
      return await repoGetMovement(id, externalClient);
    }

    const barMovement = await prepareMaterialBarPostingTx(client, { scope: barScope, movement: physicalMovement,
      command: body.material_bars, owner: physicalBarOwner, externalTransaction: !!externalClient });
    const lockedStates = await lockStockStates(client, [
      { stock_level_id: m.stock_level_id, stock_batch_id: m.stock_batch_id },
    ]);
    const sourceState = lockedStates.get(
      stockTargetKey({ stock_level_id: m.stock_level_id, stock_batch_id: m.stock_batch_id })
    );
    if (!sourceState) throw new Error("Locked stock state missing");
    // A full reversal of an untouched remnant is a stock correction, not an
    // authorization to manufacture with unreleased material. Only the shared
    // production correction transaction can post it. The immutable remnant
    // proof must match the original IN, lot, location and exact quantity.
    const remnantReversal = !!externalClient && m.movement_type === 'ADJUSTMENT' && m.qty < 0
      && await isMaterialRemnantReversalTx(client, id);
    assertStockConsumptionAllowed(sourceState, {
      movement_type: m.movement_type,
      qty: m.qty,
      allow_nonreleased_adjustment: remnantReversal,
      negative_stock_override: body.negative_stock_override,
    });

    await client.query(
      `
        UPDATE public.stock_movements
        SET
          status = 'POSTED',
          posted_at = now(),
          posted_by = $2,
          correlation_id = $3::uuid,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::uuid
      `,
      [id, audit.user_id, command.correlation_id]
    );

    if (barMovement) await applyMaterialBarPostingTx(client, barMovement, audit.user_id);

    await insertMovementEvent(client, {
      movement_id: id,
      event_type: "POSTED",
      old_values: { status: "DRAFT" },
      new_values: {
        status: "POSTED",
        negative_stock_override: body.negative_stock_override ?? null,
      },
      user_id: audit.user_id,
    });

    // Traçabilité #142 : une sortie matière comptabilisée pour un OF écrit sa
    // consommation DANS CETTE TRANSACTION. Pas de consommation sans mouvement
    // comptabilisé, pas de mouvement comptabilisé sans sa preuve de
    // consommation. Idempotent : rejouer la comptabilisation ne duplique rien.
    const consumption = await recordMaterialConsumptionOnPost(client, {
      movementId: id,
      actorUserId: audit.user_id ?? null,
      correlationId: command.correlation_id,
    });

    // Direct OUT has no stock-reservation row to remain as a future
    // commitment. Persist its release-capacity consumption before commit,
    // under the quality-control row lock acquired by the gate. Without this,
    // sequential unreserved movements could each pass the same release.
    if (m.movement_type === "OUT") {
      for (const decision of directOutQualityDecisions) {
        const qty = decision.target.qty_requested;
        await recordDirectLotQualityConsumption({ client, decision, qty });
      }
    }

    await insertAuditLog(client, audit, {
      action: "stock.movements.post",
      entity_type: "stock_movements",
      entity_id: id,
      details: {
        movement_no: m.movement_no,
        movement_type: m.movement_type,
        negative_stock_override: body.negative_stock_override ?? null,
        quality_gates: directOutQualityDecisions,
        reserved_quality_gate:reservedQualityDecision,
        consumed_reservation_id:reservedConsumption?.reservationId??null,
        material_remnant_reversal: remnantReversal,
        traceability_consumptions_recorded: consumption.recorded,
        traceability_consumptions_compensated: consumption.compensated,
      },
    });

    await completeStockCommand(client, {
      audit,
      command,
      command_type: "MOVEMENT_POST",
      resource_type: "stock_movement",
      resource_id: id,
      result_payload: {
        movement_id: id,
        status: "POSTED",
        movement_type: m.movement_type,
      },
    });

    if (ownsTransaction) await client.query("COMMIT");
    return await repoGetMovement(id, externalClient);
  } catch (err) {
    if (ownsTransaction) await client.query("ROLLBACK");
    throw err;
  } finally {
    if (ownsTransaction) client.release();
  }
}



export async function isMaterialRemnantReversalTx(client: PoolClient, movementId: string): Promise<boolean> {
  const proof = await client.query(`SELECT r.id FROM public.stock_movements m
    JOIN public.stock_movements original ON original.id=m.reversal_of_id
    JOIN public.production_material_remnants r ON r.stock_movement_id=original.id
    JOIN public.production_material_debits d ON d.id=r.debit_id AND d.compensates_id IS NULL
    JOIN public.stock_batches b ON b.id=m.stock_batch_id AND b.lot_id=r.lot_id
    WHERE m.id=$1::uuid AND m.status='DRAFT' AND m.movement_type='ADJUSTMENT' AND m.qty<0
      AND original.status='POSTED' AND original.movement_type='IN'
      AND m.article_id=original.article_id AND m.stock_level_id=original.stock_level_id
      AND m.stock_batch_id=original.stock_batch_id AND m.qty=-original.qty AND abs(m.qty)=r.quantity
      AND m.source_document_type='STOCK_COMPENSATION' AND m.source_document_id=original.id::text
      AND NOT EXISTS(SELECT 1 FROM public.stock_reservations s WHERE s.lot_id=r.lot_id AND(s.status='ACTIVE' OR s.qty_consumed>0))
      AND NOT EXISTS(SELECT 1 FROM public.stock_lot_genealogy_edges e WHERE e.parent_lot_id=r.lot_id)
      AND NOT EXISTS(SELECT 1 FROM public.stock_movement_lines ml JOIN public.stock_movements used ON used.id=ml.movement_id
        WHERE ml.lot_id=r.lot_id AND used.id NOT IN(m.id,original.id) AND used.status<>'CANCELLED')`, [movementId]);
  return proof.rows.length === 1;
}
