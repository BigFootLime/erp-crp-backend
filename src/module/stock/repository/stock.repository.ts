import type { PoolClient } from "pg";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import type {
  Paginated,
  StockArticleDetail,
  StockArticleKpis,
  StockArticleListItem,
  StockBalanceRow,
  StockDocument,
  StockEmplacementListItem,
  StockInventorySessionDetail,
  StockInventorySessionLine,
  StockInventorySessionListItem,
  StockLotDetail,
  StockLotListItem,
  StockMagasinDetail,
  StockMagasinKpis,
  StockMagasinListItem,
  StockMovementDetail,
  StockMovementEvent,
  StockMovementLineDetail,
  StockMovementListItem,
} from "../types/stock.types";
import type {
  CreateArticleBodyDTO,
  CreateEmplacementBodyDTO,
  CreateInventorySessionBodyDTO,
  CreateLotBodyDTO,
  CreateMagasinBodyDTO,
  CreateMovementBodyDTO,
  CreateMovementLineDTO,
  ListArticlesQueryDTO,
  ListBalancesQueryDTO,
  ListEmplacementsQueryDTO,
  ListInventorySessionsQueryDTO,
  ListLotsQueryDTO,
  ListMagasinsQueryDTO,
  ListMovementsQueryDTO,
  StockMovementTypeDTO,
  UpsertInventoryLineBodyDTO,
  UpdateArticleBodyDTO,
  UpdateEmplacementBodyDTO,
  UpdateLotBodyDTO,
  UpdateMagasinBodyDTO,
} from "../validators/stock.validators";

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

type UploadedDocument = Express.Multer.File;

function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505";
}

function sortDirection(sortDir: "asc" | "desc" | undefined): "ASC" | "DESC" {
  return sortDir === "asc" ? "ASC" : "DESC";
}

function safeDocExtension(originalName: string): string {
  const extCandidate = path.extname(originalName).toLowerCase();
  const safeExt = /^\.[a-z0-9]+$/.test(extCandidate) && extCandidate.length <= 10 ? extCandidate : "";
  return safeExt;
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function insertAuditLog(
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

function normalizeLikeQuery(raw: string): string {
  return `%${raw.trim()}%`;
}

function articleSortColumn(sortBy: ListArticlesQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "a.created_at";
    case "code":
      return "a.code";
    case "designation":
      return "a.designation";
    case "updated_at":
    default:
      return "a.updated_at";
  }
}

function magasinSortColumn(sortBy: ListMagasinsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "m.created_at";
    case "code":
      return "COALESCE(m.code, m.code_magasin)";
    case "name":
      return "COALESCE(m.name, m.libelle)";
    case "updated_at":
    default:
      return "m.updated_at";
  }
}

function lotSortColumn(sortBy: ListLotsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "l.created_at";
    case "lot_code":
      return "l.lot_code";
    case "received_at":
      return "l.received_at";
    case "updated_at":
    default:
      return "l.updated_at";
  }
}

function emplacementSortColumn(sortBy: ListEmplacementsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "e.created_at";
    case "code":
      return "e.code";
    case "updated_at":
    default:
      return "e.updated_at";
  }
}

function movementSortColumn(sortBy: ListMovementsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "id":
      return "m.id";
    case "created_at":
      return "m.created_at";
    case "updated_at":
      return "m.updated_at";
    case "posted_at":
      return "m.posted_at";
    case "movement_no":
      return "m.movement_no";
    case "effective_at":
    default:
      return "m.effective_at";
  }
}

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

function movementNoFromSeq(n: number): string {
  const padded = String(n).padStart(8, "0");
  return `SM-${padded}`;
}

async function reserveMovementNo(client: Pick<PoolClient, "query">): Promise<string> {
  const res = await client.query<{ n: string }>(`SELECT nextval('public.stock_movement_no_seq')::text AS n`);
  const raw = res.rows[0]?.n;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new Error("Failed to reserve stock movement number");
  return movementNoFromSeq(n);
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

function parseEffectiveAt(raw: string | null | undefined): Date {
  if (!raw) return new Date();
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) {
    throw new HttpError(400, "INVALID_EFFECTIVE_AT", "Invalid effective_at");
  }
  return dt;
}

async function resolveUnitIdForArticle(
  client: Pick<PoolClient, "query">,
  articleId: string,
  preferredUnitCode: string | null | undefined
): Promise<string> {
  const preferred = preferredUnitCode?.trim() ? preferredUnitCode.trim() : null;
  let code: string | null = preferred;

  if (!code) {
    const a = await client.query<{ unite: string | null }>(
      `SELECT unite FROM public.articles WHERE id = $1::uuid`,
      [articleId]
    );
    code = a.rows[0]?.unite?.trim() ? a.rows[0].unite.trim() : null;
  }

  if (!code) code = "u";

  const u = await client.query<{ id: string }>(`SELECT id::text AS id FROM public.units WHERE code = $1`, [code]);
  const unitId = u.rows[0]?.id;
  if (!unitId) {
    throw new HttpError(400, "UNKNOWN_UNIT", `Unknown unit code: ${code}`);
  }
  return unitId;
}

type EmplacementMapping = {
  magasin_id: string;
  location_id: string;
  warehouse_id: string;
};

async function getEmplacementMapping(
  client: Pick<PoolClient, "query">,
  magasinId: string,
  emplacementId: number,
  label: "src" | "dst"
): Promise<EmplacementMapping> {
  const res = await client.query<{
    magasin_id: string;
    location_id: string | null;
    warehouse_id: string | null;
  }>(
    `
      SELECT
        e.magasin_id::text AS magasin_id,
        e.location_id::text AS location_id,
        l.warehouse_id::text AS warehouse_id
      FROM public.emplacements e
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
  if (!row.location_id || !row.warehouse_id) {
    throw new HttpError(409, "LOCATION_NOT_MAPPED", `Emplacement is missing ${label} location mapping`);
  }

  return {
    magasin_id: row.magasin_id,
    location_id: row.location_id,
    warehouse_id: row.warehouse_id,
  };
}

async function ensureStockLevel(
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

async function ensureStockBatchId(
  client: Pick<PoolClient, "query">,
  args: {
    stock_level_id: string;
    lot_id: string;
  }
): Promise<string> {
  const lot = await client.query<{ lot_code: string }>(
    `SELECT lot_code FROM public.lots WHERE id = $1::uuid`,
    [args.lot_id]
  );
  const lotCode = lot.rows[0]?.lot_code;
  if (!lotCode) throw new HttpError(400, "INVALID_LOT", "Unknown lot_id");

  await client.query(
    `
      INSERT INTO public.stock_batches (stock_level_id, batch_code)
      VALUES ($1::uuid,$2)
      ON CONFLICT (stock_level_id, batch_code) DO NOTHING
    `,
    [args.stock_level_id, lotCode]
  );

  const b = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM public.stock_batches WHERE stock_level_id = $1::uuid AND batch_code = $2`,
    [args.stock_level_id, lotCode]
  );
  const id = b.rows[0]?.id;
  if (!id) throw new Error("Failed to ensure stock batch");
  return id;
}

function sumQty(lines: CreateMovementLineDTO[]): number {
  return lines.reduce((acc, l) => acc + (typeof l.qty === "number" ? l.qty : 0), 0);
}

function assertSameArticle(lines: CreateMovementLineDTO[]) {
  const first = lines[0]?.article_id;
  if (!first) throw new HttpError(400, "INVALID_MOVEMENT", "Missing article_id");
  for (const l of lines) {
    if (l.article_id !== first) {
      throw new HttpError(400, "INVALID_MOVEMENT", "All movement lines must have the same article_id");
    }
  }
}

function assertSameLotIfSet(lines: CreateMovementLineDTO[]): string | null {
  const firstLot = lines[0]?.lot_id ?? null;
  for (const l of lines) {
    const lot = l.lot_id ?? null;
    if (lot !== firstLot) return null;
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

function assertConsistentLocations(lines: CreateMovementLineDTO[], movementType: StockMovementTypeDTO) {
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

async function insertMovementEvent(
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

export async function repoListArticles(filters: ListArticlesQueryDTO): Promise<Paginated<StockArticleListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
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
    where.push(`(a.code ILIKE ${p} OR a.designation ILIKE ${p})`);
  }
  if (filters.article_type) where.push(`a.article_type = ${push(filters.article_type)}`);
  if (filters.is_active !== undefined) where.push(`a.is_active = ${push(filters.is_active)}`);
  if (filters.lot_tracking !== undefined) where.push(`a.lot_tracking = ${push(filters.lot_tracking)}`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = articleSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.articles a ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      a.id::text AS id,
      a.code,
      a.designation,
      a.article_type,
      a.piece_technique_id::text AS piece_technique_id,
      pt.code_piece AS piece_code,
      pt.designation AS piece_designation,
      a.unite,
      a.lot_tracking,
      a.is_active,
      a.updated_at::text AS updated_at,
      a.created_at::text AS created_at
    FROM public.articles a
    LEFT JOIN public.pieces_techniques pt
      ON pt.id = a.piece_technique_id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockArticleListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

export async function repoGetArticle(id: string): Promise<StockArticleDetail | null> {
  const res = await db.query<StockArticleDetail>(
    `
      SELECT
        a.id::text AS id,
        a.code,
        a.designation,
        a.article_type,
        a.piece_technique_id::text AS piece_technique_id,
        pt.code_piece AS piece_code,
        pt.designation AS piece_designation,
        a.unite,
        a.lot_tracking,
        a.is_active,
        a.notes,
        a.updated_at::text AS updated_at,
        a.created_at::text AS created_at
      FROM public.articles a
      LEFT JOIN public.pieces_techniques pt
        ON pt.id = a.piece_technique_id
      WHERE a.id = $1::uuid
    `,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function repoGetArticlesKpis(): Promise<StockArticleKpis> {
  const res = await db.query<StockArticleKpis>(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE is_active)::int AS active,
        COUNT(*) FILTER (WHERE lot_tracking)::int AS lot_tracked,
        COUNT(*) FILTER (WHERE article_type = 'PIECE_TECHNIQUE')::int AS piece_technique,
        COUNT(*) FILTER (WHERE article_type = 'PURCHASED')::int AS purchased
      FROM public.articles
    `
  );
  return (
    res.rows[0] ?? {
      total: 0,
      active: 0,
      lot_tracked: 0,
      piece_technique: 0,
      purchased: 0,
    }
  );
}

export async function repoCreateArticle(body: CreateArticleBodyDTO, audit: AuditContext): Promise<StockArticleDetail> {
  try {
    const res = await db.query<{ id: string }>(
      `
        INSERT INTO public.articles (
          code, designation, article_type, piece_technique_id, unite,
          lot_tracking, is_active, notes,
          created_by, updated_by
        )
        VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$9)
        RETURNING id::text AS id
      `,
      [
        body.code,
        body.designation,
        body.article_type,
        body.piece_technique_id ?? null,
        body.unite ?? null,
        body.lot_tracking,
        body.is_active,
        body.notes ?? null,
        audit.user_id,
      ]
    );

    const id = res.rows[0]?.id;
    if (!id) throw new Error("Failed to create article");
    const out = await repoGetArticle(id);
    if (!out) throw new Error("Failed to read created article");

    await insertAuditLog(db, audit, {
      action: "stock.articles.create",
      entity_type: "articles",
      entity_id: id,
      details: {
        code: body.code,
        designation: body.designation,
        article_type: body.article_type,
      },
    });

    return out;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Article code already exists");
    }
    throw err;
  }
}

export async function repoUpdateArticle(
  id: string,
  patch: UpdateArticleBodyDTO,
  audit: AuditContext
): Promise<StockArticleDetail | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (patch.code !== undefined) sets.push(`code = ${push(patch.code)}`);
  if (patch.designation !== undefined) sets.push(`designation = ${push(patch.designation)}`);
  if (patch.article_type !== undefined) sets.push(`article_type = ${push(patch.article_type)}`);
  if (patch.piece_technique_id !== undefined) sets.push(`piece_technique_id = ${push(patch.piece_technique_id)}::uuid`);
  if (patch.unite !== undefined) sets.push(`unite = ${push(patch.unite)}`);
  if (patch.lot_tracking !== undefined) sets.push(`lot_tracking = ${push(patch.lot_tracking)}`);
  if (patch.is_active !== undefined) sets.push(`is_active = ${push(patch.is_active)}`);
  if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`);

  sets.push(`updated_at = now()`);
  sets.push(`updated_by = ${push(audit.user_id)}`);

  const sql = `
    UPDATE public.articles
    SET ${sets.join(", ")}
    WHERE id = ${push(id)}::uuid
    RETURNING id::text AS id
  `;

  try {
    const res = await db.query<{ id: string }>(sql, values);
    const rowId = res.rows[0]?.id;
    if (!rowId) return null;

    await insertAuditLog(db, audit, {
      action: "stock.articles.update",
      entity_type: "articles",
      entity_id: id,
      details: { patch },
    });

    return repoGetArticle(id);
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Article code already exists");
    }
    throw err;
  }
}

export async function repoListMagasins(filters: ListMagasinsQueryDTO): Promise<Paginated<StockMagasinListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
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
    where.push(
      `(
        COALESCE(m.code, m.code_magasin) ILIKE ${p}
        OR COALESCE(m.name, m.libelle) ILIKE ${p}
      )`
    );
  }
  if (filters.is_active !== undefined) where.push(`m.is_active = ${push(filters.is_active)}`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = magasinSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.magasins m ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      m.id::text AS id,
      COALESCE(m.code, m.code_magasin)::text AS code,
      COALESCE(m.name, m.libelle)::text AS name,
      m.is_active,
      COALESCE(m.updated_at, now())::text AS updated_at,
      COALESCE(m.created_at, now())::text AS created_at,
      COALESCE(ec.emplacements_count, 0)::int AS emplacements_count,
      COALESCE(ec.scrap_emplacements_count, 0)::int AS scrap_emplacements_count
    FROM public.magasins m
    LEFT JOIN (
      SELECT
        magasin_id,
        COUNT(*)::int AS emplacements_count,
        COUNT(*) FILTER (WHERE is_scrap)::int AS scrap_emplacements_count
      FROM public.emplacements
      GROUP BY magasin_id
    ) ec ON ec.magasin_id = m.id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockMagasinListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

export async function repoGetMagasin(id: string): Promise<StockMagasinDetail | null> {
  const m = await db.query<StockMagasinDetail["magasin"]>(
    `
      SELECT
        id::text AS id,
        COALESCE(code, code_magasin)::text AS code,
        COALESCE(name, libelle)::text AS name,
        is_active,
        notes,
        COALESCE(updated_at, now())::text AS updated_at,
        COALESCE(created_at, now())::text AS created_at
      FROM public.magasins
      WHERE id = $1::uuid
    `,
    [id]
  );

  const magasin = m.rows[0] ?? null;
  if (!magasin) return null;

  const e = await db.query<StockEmplacementListItem>(
    `
      SELECT
        e.id::int AS id,
        e.magasin_id::text AS magasin_id,
        COALESCE(m.code, m.code_magasin)::text AS magasin_code,
        COALESCE(m.name, m.libelle)::text AS magasin_name,
        e.code,
        e.name,
        e.is_scrap,
        e.is_active,
        e.updated_at::text AS updated_at,
        e.created_at::text AS created_at
      FROM public.emplacements e
      JOIN public.magasins m ON m.id = e.magasin_id
      WHERE e.magasin_id = $1::uuid
      ORDER BY e.code ASC, e.id ASC
    `,
    [id]
  );

  return { magasin, emplacements: e.rows };
}

export async function repoGetMagasinsKpis(): Promise<StockMagasinKpis> {
  const res = await db.query<StockMagasinKpis>(
    `
      SELECT
        (SELECT COUNT(*) FROM public.magasins)::int AS magasins_total,
        (SELECT COUNT(*) FROM public.magasins WHERE is_active)::int AS magasins_active,
        (SELECT COUNT(*) FROM public.emplacements)::int AS emplacements_total,
        (SELECT COUNT(*) FROM public.emplacements WHERE is_scrap)::int AS emplacements_scrap
    `
  );
  return (
    res.rows[0] ?? {
      magasins_total: 0,
      magasins_active: 0,
      emplacements_total: 0,
      emplacements_scrap: 0,
    }
  );
}

export async function repoCreateMagasin(body: CreateMagasinBodyDTO, audit: AuditContext): Promise<StockMagasinDetail["magasin"]> {
  try {
    const res = await db.query<{ id: string }>(
      `
        INSERT INTO public.magasins (
          code_magasin, libelle,
          code, name,
          actif, is_active,
          notes,
          created_by, updated_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
        RETURNING id::text AS id
      `,
      [
        body.code,
        body.name,
        body.code,
        body.name,
        body.is_active,
        body.is_active,
        body.notes ?? null,
        audit.user_id,
      ]
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error("Failed to create magasin");

    await insertAuditLog(db, audit, {
      action: "stock.magasins.create",
      entity_type: "magasins",
      entity_id: id,
      details: { code: body.code, name: body.name },
    });

    const out = await repoGetMagasin(id);
    if (!out) throw new Error("Failed to read created magasin");
    return out.magasin;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Magasin code already exists");
    }
    throw err;
  }
}

export async function repoUpdateMagasin(
  id: string,
  patch: UpdateMagasinBodyDTO,
  audit: AuditContext
): Promise<StockMagasinDetail["magasin"] | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (patch.code !== undefined) {
    sets.push(`code = ${push(patch.code)}`);
    sets.push(`code_magasin = ${push(patch.code)}`);
  }
  if (patch.name !== undefined) {
    sets.push(`name = ${push(patch.name)}`);
    sets.push(`libelle = ${push(patch.name)}`);
  }
  if (patch.is_active !== undefined) {
    sets.push(`is_active = ${push(patch.is_active)}`);
    sets.push(`actif = ${push(patch.is_active)}`);
  }
  if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`);
  sets.push(`updated_at = now()`);
  sets.push(`updated_by = ${push(audit.user_id)}`);

  try {
    const res = await db.query<{ id: string }>(
      `UPDATE public.magasins SET ${sets.join(", ")} WHERE id = ${push(id)}::uuid RETURNING id::text AS id`,
      values
    );
    if (!res.rows[0]?.id) return null;

    await insertAuditLog(db, audit, {
      action: "stock.magasins.update",
      entity_type: "magasins",
      entity_id: id,
      details: { patch },
    });

    const out = await repoGetMagasin(id);
    return out?.magasin ?? null;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Magasin code already exists");
    }
    throw err;
  }
}

export async function repoDeactivateMagasin(id: string, audit: AuditContext): Promise<StockMagasinDetail["magasin"] | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM public.magasins WHERE id = $1::uuid FOR UPDATE`,
      [id]
    );
    if (!exists.rows[0]?.id) {
      await client.query("ROLLBACK");
      return null;
    }

    const blocking = await client.query<{ key: string; value_text: string }>(
      `
        SELECT s.key, s.value_text
        FROM public.erp_settings s
        WHERE s.key IN ('stock.default_shipping_location','stock.default_receipt_location')
          AND s.value_text IS NOT NULL
          AND s.value_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND EXISTS (
            SELECT 1
            FROM public.emplacements e
            WHERE e.magasin_id = $1::uuid
              AND e.location_id = s.value_text::uuid
          )
        LIMIT 1
      `,
      [id]
    );

    const blocked = blocking.rows[0] ?? null;
    if (blocked) {
      throw new HttpError(
        409,
        "MAGASIN_DEFAULT_LOCATION",
        "Impossible de desactiver ce magasin : il contient l'emplacement utilise comme emplacement par defaut dans les parametres."
      );
    }

    await client.query(
      `
        UPDATE public.magasins
        SET
          is_active = false,
          actif = false,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::uuid
      `,
      [id, audit.user_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.magasins.deactivate",
      entity_type: "magasins",
      entity_id: id,
      details: null,
    });

    await client.query("COMMIT");
    const out = await repoGetMagasin(id);
    return out?.magasin ?? null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoActivateMagasin(id: string, audit: AuditContext): Promise<StockMagasinDetail["magasin"] | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM public.magasins WHERE id = $1::uuid FOR UPDATE`,
      [id]
    );
    if (!exists.rows[0]?.id) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `
        UPDATE public.magasins
        SET
          is_active = true,
          actif = true,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::uuid
      `,
      [id, audit.user_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.magasins.activate",
      entity_type: "magasins",
      entity_id: id,
      details: null,
    });

    await client.query("COMMIT");
    const out = await repoGetMagasin(id);
    return out?.magasin ?? null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoListEmplacements(filters: ListEmplacementsQueryDTO): Promise<Paginated<StockEmplacementListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.magasin_id) where.push(`e.magasin_id = ${push(filters.magasin_id)}::uuid`);
  if (filters.is_active !== undefined) where.push(`e.is_active = ${push(filters.is_active)}`);
  if (filters.is_scrap !== undefined) where.push(`e.is_scrap = ${push(filters.is_scrap)}`);
  if (filters.q && filters.q.trim().length > 0) {
    const q = normalizeLikeQuery(filters.q);
    const p = push(q);
    where.push(
      `(
        e.code ILIKE ${p}
        OR COALESCE(e.name, '') ILIKE ${p}
        OR COALESCE(m.code, m.code_magasin) ILIKE ${p}
        OR COALESCE(m.name, m.libelle) ILIKE ${p}
      )`
    );
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = emplacementSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.emplacements e JOIN public.magasins m ON m.id = e.magasin_id ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      e.id::int AS id,
      e.magasin_id::text AS magasin_id,
      COALESCE(m.code, m.code_magasin)::text AS magasin_code,
      COALESCE(m.name, m.libelle)::text AS magasin_name,
      e.code,
      e.name,
      e.is_scrap,
      e.is_active,
      e.updated_at::text AS updated_at,
      e.created_at::text AS created_at
    FROM public.emplacements e
    JOIN public.magasins m ON m.id = e.magasin_id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;
  const rows = await db.query<StockEmplacementListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

export async function repoCreateEmplacement(
  magasinId: string,
  body: CreateEmplacementBodyDTO,
  audit: AuditContext
): Promise<StockEmplacementListItem | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const mag = await client.query<{ ok: number; code: string; name: string }>(
      `
        SELECT
          1::int AS ok,
          COALESCE(code, code_magasin)::text AS code,
          COALESCE(name, libelle)::text AS name
        FROM public.magasins
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [magasinId]
    );
    const base = mag.rows[0] ?? null;
    if (!base?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const ins = await client.query<{ id: number }>(
      `
        INSERT INTO public.emplacements (magasin_id, code, name, is_scrap, is_active, notes, created_by, updated_by)
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$7)
        RETURNING id::int AS id
      `,
      [magasinId, body.code, body.name ?? null, body.is_scrap, body.is_active, body.notes ?? null, audit.user_id]
    );
    const id = ins.rows[0]?.id;
    if (!id) throw new Error("Failed to create emplacement");

    await insertAuditLog(client, audit, {
      action: "stock.emplacements.create",
      entity_type: "emplacements",
      entity_id: String(id),
      details: {
        magasin_id: magasinId,
        magasin_code: base.code,
        code: body.code,
        is_scrap: body.is_scrap,
      },
    });

    await client.query("COMMIT");

    const out = await db.query<StockEmplacementListItem>(
      `
        SELECT
          e.id::int AS id,
          e.magasin_id::text AS magasin_id,
          COALESCE(m.code, m.code_magasin)::text AS magasin_code,
          COALESCE(m.name, m.libelle)::text AS magasin_name,
          e.code,
          e.name,
          e.is_scrap,
          e.is_active,
          e.updated_at::text AS updated_at,
          e.created_at::text AS created_at
        FROM public.emplacements e
        JOIN public.magasins m ON m.id = e.magasin_id
        WHERE e.id = $1::bigint
      `,
      [id]
    );
    return out.rows[0] ?? null;
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Emplacement code already exists in this magasin");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateEmplacement(
  id: number,
  patch: UpdateEmplacementBodyDTO,
  audit: AuditContext
): Promise<StockEmplacementListItem | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (patch.code !== undefined) sets.push(`code = ${push(patch.code)}`);
  if (patch.name !== undefined) sets.push(`name = ${push(patch.name)}`);
  if (patch.is_scrap !== undefined) sets.push(`is_scrap = ${push(patch.is_scrap)}`);
  if (patch.is_active !== undefined) sets.push(`is_active = ${push(patch.is_active)}`);
  if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`);
  sets.push(`updated_at = now()`);
  sets.push(`updated_by = ${push(audit.user_id)}`);

  try {
    const res = await db.query<{ id: number }>(
      `UPDATE public.emplacements SET ${sets.join(", ")} WHERE id = ${push(id)}::bigint RETURNING id::int AS id`,
      values
    );
    if (!res.rows[0]?.id) return null;

    await insertAuditLog(db, audit, {
      action: "stock.emplacements.update",
      entity_type: "emplacements",
      entity_id: String(id),
      details: { patch },
    });

    const out = await db.query<StockEmplacementListItem>(
      `
        SELECT
          e.id::int AS id,
          e.magasin_id::text AS magasin_id,
          COALESCE(m.code, m.code_magasin)::text AS magasin_code,
          COALESCE(m.name, m.libelle)::text AS magasin_name,
          e.code,
          e.name,
          e.is_scrap,
          e.is_active,
          e.updated_at::text AS updated_at,
          e.created_at::text AS created_at
        FROM public.emplacements e
        JOIN public.magasins m ON m.id = e.magasin_id
        WHERE e.id = $1::bigint
      `,
      [id]
    );
    return out.rows[0] ?? null;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Emplacement code already exists in this magasin");
    }
    throw err;
  }
}

export async function repoListLots(filters: ListLotsQueryDTO): Promise<Paginated<StockLotListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.article_id) where.push(`l.article_id = ${push(filters.article_id)}::uuid`);
  if (filters.q && filters.q.trim().length > 0) {
    const q = normalizeLikeQuery(filters.q);
    const p = push(q);
    where.push(
      `(
        l.lot_code ILIKE ${p}
        OR COALESCE(l.supplier_lot_code, '') ILIKE ${p}
        OR a.code ILIKE ${p}
        OR a.designation ILIKE ${p}
      )`
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = lotSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.lots l JOIN public.articles a ON a.id = l.article_id ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      l.id::text AS id,
      l.article_id::text AS article_id,
      a.code AS article_code,
      a.designation AS article_designation,
      l.lot_code,
      l.supplier_lot_code,
      l.received_at::text AS received_at,
      l.manufactured_at::text AS manufactured_at,
      l.expiry_at::text AS expiry_at,
      l.updated_at::text AS updated_at,
      l.created_at::text AS created_at
    FROM public.lots l
    JOIN public.articles a ON a.id = l.article_id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockLotListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

export async function repoGetLot(id: string): Promise<StockLotDetail | null> {
  const res = await db.query<StockLotDetail>(
    `
      SELECT
        l.id::text AS id,
        l.article_id::text AS article_id,
        a.code AS article_code,
        a.designation AS article_designation,
        l.lot_code,
        l.supplier_lot_code,
        l.received_at::text AS received_at,
        l.manufactured_at::text AS manufactured_at,
        l.expiry_at::text AS expiry_at,
        l.notes,
        l.updated_at::text AS updated_at,
        l.created_at::text AS created_at
      FROM public.lots l
      JOIN public.articles a ON a.id = l.article_id
      WHERE l.id = $1::uuid
    `,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function repoCreateLot(body: CreateLotBodyDTO, audit: AuditContext): Promise<StockLotDetail> {
  try {
    const res = await db.query<{ id: string }>(
      `
        INSERT INTO public.lots (
          article_id, lot_code, supplier_lot_code,
          received_at, manufactured_at, expiry_at,
          notes, created_by, updated_by
        )
        VALUES ($1::uuid,$2,$3,$4::date,$5::date,$6::date,$7,$8,$8)
        RETURNING id::text AS id
      `,
      [
        body.article_id,
        body.lot_code,
        body.supplier_lot_code ?? null,
        body.received_at ?? null,
        body.manufactured_at ?? null,
        body.expiry_at ?? null,
        body.notes ?? null,
        audit.user_id,
      ]
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error("Failed to create lot");

    await insertAuditLog(db, audit, {
      action: "stock.lots.create",
      entity_type: "lots",
      entity_id: id,
      details: { article_id: body.article_id, lot_code: body.lot_code },
    });

    const out = await repoGetLot(id);
    if (!out) throw new Error("Failed to read created lot");
    return out;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Lot code already exists for this article");
    }
    throw err;
  }
}

export async function repoUpdateLot(id: string, patch: UpdateLotBodyDTO, audit: AuditContext): Promise<StockLotDetail | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (patch.lot_code !== undefined) sets.push(`lot_code = ${push(patch.lot_code)}`);
  if (patch.supplier_lot_code !== undefined) sets.push(`supplier_lot_code = ${push(patch.supplier_lot_code)}`);
  if (patch.received_at !== undefined) sets.push(`received_at = ${push(patch.received_at)}::date`);
  if (patch.manufactured_at !== undefined) sets.push(`manufactured_at = ${push(patch.manufactured_at)}::date`);
  if (patch.expiry_at !== undefined) sets.push(`expiry_at = ${push(patch.expiry_at)}::date`);
  if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`);
  sets.push(`updated_at = now()`);
  sets.push(`updated_by = ${push(audit.user_id)}`);

  try {
    const res = await db.query<{ id: string }>(
      `UPDATE public.lots SET ${sets.join(", ")} WHERE id = ${push(id)}::uuid RETURNING id::text AS id`,
      values
    );
    if (!res.rows[0]?.id) return null;

    await insertAuditLog(db, audit, {
      action: "stock.lots.update",
      entity_type: "lots",
      entity_id: id,
      details: { patch },
    });

    return repoGetLot(id);
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Lot code already exists for this article");
    }
    throw err;
  }
}

export async function repoListBalances(filters: ListBalancesQueryDTO): Promise<Paginated<StockBalanceRow>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 100;
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.article_id) where.push(`b.article_id = ${push(filters.article_id)}::uuid`);
  if (filters.warehouse_id) where.push(`b.warehouse_id = ${push(filters.warehouse_id)}::uuid`);
  if (filters.location_id) where.push(`b.location_id = ${push(filters.location_id)}::uuid`);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.v_stock_current b ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      b.id::text AS id,
      b.article_id::text AS article_id,
      a.code AS article_code,
      a.designation AS article_designation,
      b.warehouse_id::text AS warehouse_id,
      w.code::text AS warehouse_code,
      w.name AS warehouse_name,
      b.location_id::text AS location_id,
      l.code::text AS location_code,
      l.description AS location_description,
      b.unit_id::text AS unit_id,
      u.code::text AS unit_code,
      b.managed_in_stock,
      b.qty_total::float8 AS qty_total,
      b.qty_reserved::float8 AS qty_reserved,
      b.qty_depreciated::float8 AS qty_depreciated,
      b.qty_available::float8 AS qty_available,
      b.updated_at::text AS updated_at
    FROM public.v_stock_current b
    JOIN public.articles a ON a.id = b.article_id
    JOIN public.warehouses w ON w.id = b.warehouse_id
    JOIN public.locations l ON l.id = b.location_id
    JOIN public.units u ON u.id = b.unit_id
    ${whereSql}
    ORDER BY a.code ASC, w.code ASC, l.code ASC
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockBalanceRow>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

export async function repoListMovements(filters: ListMovementsQueryDTO): Promise<Paginated<StockMovementListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const where: string[] = [`(m.doc_type IS DISTINCT FROM 'STOCK_TRANSFER_INTERNAL')`];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const q = normalizeLikeQuery(filters.q);
    const p = push(q);
    where.push(`(m.movement_no ILIKE ${p} OR COALESCE(m.source_document_id, '') ILIKE ${p})`);
  }
  if (filters.movement_type) where.push(`m.movement_type = ${push(filters.movement_type)}::public.movement_type`);
  if (filters.status) where.push(`m.status = ${push(filters.status)}`);
  if (filters.article_id) where.push(`m.article_id = ${push(filters.article_id)}::uuid`);
  if (filters.from) where.push(`m.effective_at >= ${push(filters.from)}::timestamptz`);
  if (filters.to) where.push(`m.effective_at <= ${push(filters.to)}::timestamptz`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = movementSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM public.stock_movements m ${whereSql}`, values);
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      m.id::text AS id,
      m.movement_no,
      m.movement_type::text AS movement_type,
      m.status,
      m.article_id::text AS article_id,
      a.code AS article_code,
      a.designation AS article_designation,
      m.qty::float8 AS qty,
      m.effective_at::text AS effective_at,
      m.posted_at::text AS posted_at,
      m.source_document_type,
      m.source_document_id,
      m.reason_code,
      m.updated_at::text AS updated_at,
      m.created_at::text AS created_at,
      COALESCE(ml.lines_count, 0)::int AS lines_count
    FROM public.stock_movements m
    JOIN public.articles a ON a.id = m.article_id
    LEFT JOIN (
      SELECT movement_id, COUNT(*)::int AS lines_count
      FROM public.stock_movement_lines
      GROUP BY movement_id
    ) ml ON ml.movement_id = m.id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockMovementListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

type MovementRow = StockMovementDetail["movement"];

export async function repoGetMovement(id: string): Promise<StockMovementDetail | null> {
  const m = await db.query<MovementRow>(
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

  const l = await db.query<StockMovementLineDetail>(
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

  const docs = await db.query<StockDocument>(
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

  const events = await db.query<StockMovementEvent>(
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

export async function repoCreateMovement(body: CreateMovementBodyDTO, audit: AuditContext): Promise<StockMovementDetail> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    assertSameArticle(body.lines);
    assertConsistentLocations(body.lines, body.movement_type);

    const movementNo = await reserveMovementNo(client);
    const effectiveAt = parseEffectiveAt(body.effective_at);
    const articleId = body.lines[0]?.article_id;
    if (!articleId) throw new HttpError(400, "INVALID_MOVEMENT", "Missing article_id");

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
      body.movement_type === "RESERVE" ||
      body.movement_type === "UNRESERVE" ||
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
        user_id,
        created_by,
        updated_by
      )
      VALUES ($1,$2::public.movement_type,'DRAFT',$3::uuid,$4::uuid,$5::uuid,$6,'EUR',$7,$8,$9,$10,$11,$12,$13,$13,$13)
      RETURNING id::text AS id
    `;

    let movementId: string;
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
        body.idempotency_key ?? null,
        audit.user_id,
      ]);
      movementId = ins.rows[0]?.id ?? "";
      if (!movementId) throw new Error("Failed to create movement");
    } catch (err) {
      if (body.idempotency_key && isPgUniqueViolation(err)) {
        const existing = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM public.stock_movements WHERE idempotency_key = $1`,
          [body.idempotency_key]
        );
        const id = existing.rows[0]?.id;
        if (!id) throw err;
        await client.query("COMMIT");
        const out = await repoGetMovement(id);
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
      },
    });

    await client.query("COMMIT");
    const out = await repoGetMovement(movementId);
    if (!out) throw new Error("Failed to read created movement");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoPostMovement(id: string, audit: AuditContext): Promise<StockMovementDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const lock = await client.query<{
      id: string;
      status: string;
      movement_type: StockMovementTypeDTO;
      movement_no: string | null;
      effective_at: string;
      article_id: string;
      notes: string | null;
    }>(
      `
        SELECT
          id::text AS id,
          status,
          movement_type::text AS movement_type,
          movement_no,
          effective_at::text AS effective_at,
          article_id::text AS article_id,
          notes
        FROM public.stock_movements
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [id]
    );

    const m = lock.rows[0] ?? null;
    if (!m) {
      await client.query("ROLLBACK");
      return null;
    }
    if (m.status !== "DRAFT") {
      throw new HttpError(409, "INVALID_STATUS", "Only DRAFT movements can be posted");
    }

    if (m.movement_type === "TRANSFER") {
      const lines = await client.query<CreateMovementLineDTO>(
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
      const movementLines = lines.rows;
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
            notes,
            user_id,
            created_by,
            updated_by
          )
          VALUES ($1,'OUT','POSTED',$2::uuid,$3::uuid,$4::uuid,$5,'EUR',$6,$7,$8,'STOCK_TRANSFER_INTERNAL',$9::uuid,$10,$8,$8,$8)
          RETURNING id::text AS id
        `,
        [outMovementNo, m.article_id, srcStockLevelId, srcBatchId, totalQty, m.effective_at, postedAt, audit.user_id, id, m.notes ?? null]
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
            notes,
            user_id,
            created_by,
            updated_by
          )
          VALUES ($1,'IN','POSTED',$2::uuid,$3::uuid,$4::uuid,$5,'EUR',$6,$7,$8,'STOCK_TRANSFER_INTERNAL',$9::uuid,$10,$8,$8,$8)
          RETURNING id::text AS id
        `,
        [inMovementNo, m.article_id, dstStockLevelId, dstBatchId, totalQty, m.effective_at, postedAt, audit.user_id, id, m.notes ?? null]
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
          SET status = 'POSTED', posted_at = now(), posted_by = $2, updated_at = now(), updated_by = $2
          WHERE id = $1::uuid
        `,
        [id, audit.user_id]
      );

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
          legs: [
            { movement_id: outMovementId, movement_no: outMovementNo, movement_type: "OUT" },
            { movement_id: inMovementId, movement_no: inMovementNo, movement_type: "IN" },
          ],
        },
      });

      await client.query("COMMIT");
      return repoGetMovement(id);
    }

    await client.query(
      `
        UPDATE public.stock_movements
        SET status = 'POSTED', posted_at = now(), posted_by = $2, updated_at = now(), updated_by = $2
        WHERE id = $1::uuid
      `,
      [id, audit.user_id]
    );

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
      details: { movement_no: m.movement_no, movement_type: m.movement_type },
    });

    await client.query("COMMIT");
    return repoGetMovement(id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoCancelMovement(id: string, audit: AuditContext): Promise<StockMovementDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const lock = await client.query<{ status: string; movement_no: string | null }>(
      `SELECT status, movement_no FROM public.stock_movements WHERE id = $1::uuid FOR UPDATE`,
      [id]
    );
    const m = lock.rows[0] ?? null;
    if (!m) {
      await client.query("ROLLBACK");
      return null;
    }
    if (m.status !== "DRAFT") {
      throw new HttpError(409, "INVALID_STATUS", "Only DRAFT movements can be cancelled");
    }

    await client.query(
      `UPDATE public.stock_movements SET status = 'CANCELLED', updated_at = now(), updated_by = $2 WHERE id = $1::uuid`,
      [id, audit.user_id]
    );

    await insertMovementEvent(client, {
      movement_id: id,
      event_type: "CANCELLED",
      old_values: { status: "DRAFT" },
      new_values: { status: "CANCELLED" },
      user_id: audit.user_id,
    });

    await insertAuditLog(client, audit, {
      action: "stock.movements.cancel",
      entity_type: "stock_movements",
      entity_id: id,
      details: { movement_no: m.movement_no },
    });

    await client.query("COMMIT");
    return repoGetMovement(id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

type StockDocumentRow = {
  id: string;
  original_name: string;
  stored_name: string;
  storage_path: string;
  mime_type: string;
  size_bytes: string;
  sha256: string | null;
  label: string | null;
  created_at: string;
  updated_at: string;
  uploaded_by: number | null;
  removed_at: string | null;
  removed_by: number | null;
};

async function insertStockDocuments(
  client: PoolClient,
  documents: UploadedDocument[],
  audit: AuditContext,
  baseDirRel: string
): Promise<StockDocumentRow[]> {
  if (!documents.length) return [];

  const baseDirAbs = path.resolve(baseDirRel);
  await fs.mkdir(baseDirAbs, { recursive: true });

  const inserted: StockDocumentRow[] = [];
  for (const doc of documents) {
    const documentId = crypto.randomUUID();
    const safeExt = safeDocExtension(doc.originalname);
    const storedName = `${documentId}${safeExt}`;
    const relPath = toPosixPath(path.join(baseDirRel, storedName));
    const absPath = path.join(baseDirAbs, storedName);
    const tempPath = path.resolve(doc.path);

    try {
      await fs.rename(tempPath, absPath);
    } catch {
      await fs.copyFile(tempPath, absPath);
      await fs.unlink(tempPath);
    }

    const hash = await sha256File(absPath);

    await client.query(
      `
        INSERT INTO public.documents (id, title, file_path, mime_type, kind)
        VALUES ($1::uuid,$2,$3,$4,$5)
      `,
      [documentId, doc.originalname, relPath, doc.mimetype, "stock"]
    );

    const ins = await client.query<StockDocumentRow>(
      `
        INSERT INTO public.stock_documents (
          id, original_name, stored_name, storage_path, mime_type, size_bytes,
          sha256, label, uploaded_by,
          created_by, updated_by
        )
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9)
        RETURNING
          id::text AS id,
          original_name,
          stored_name,
          storage_path,
          mime_type,
          size_bytes::text AS size_bytes,
          sha256,
          label,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          uploaded_by,
          removed_at::text AS removed_at,
          removed_by
      `,
      [documentId, doc.originalname, storedName, relPath, doc.mimetype, doc.size, hash, null, audit.user_id]
    );
    const row = ins.rows[0];
    if (!row) throw new Error("Failed to insert stock document");
    inserted.push(row);
  }

  return inserted;
}

export async function repoListArticleDocuments(articleId: string): Promise<StockDocument[] | null> {
  const exists = await db.query<{ ok: number }>(
    `SELECT 1::int AS ok FROM public.articles WHERE id = $1::uuid`,
    [articleId]
  );
  if (!exists.rows[0]?.ok) return null;

  const res = await db.query<StockDocument>(
    `
      SELECT
        sd.id::text AS document_id,
        sd.original_name AS document_name,
        ad.type
      FROM public.article_documents ad
      JOIN public.stock_documents sd ON sd.id = ad.document_id
      WHERE ad.article_id = $1::uuid
        AND sd.removed_at IS NULL
      ORDER BY ad.created_at DESC, ad.id DESC
    `,
    [articleId]
  );
  return res.rows;
}

export async function repoAttachArticleDocuments(
  articleId: string,
  documents: UploadedDocument[],
  audit: AuditContext
): Promise<StockDocument[] | null> {
  const client = await db.connect();
  const docsDirRel = path.posix.join("uploads", "docs", "stock", "articles");
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.articles WHERE id = $1::uuid FOR UPDATE`,
      [articleId]
    );
    if (!exists.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const inserted = await insertStockDocuments(client, documents, audit, docsDirRel);
    for (const d of inserted) {
      await client.query(
        `
          INSERT INTO public.article_documents (article_id, document_id, type, version, uploaded_by, created_by, updated_by)
          VALUES ($1::uuid,$2::uuid,$3,$4,$5,$5,$5)
          ON CONFLICT DO NOTHING
        `,
        [articleId, d.id, null, 1, audit.user_id]
      );
    }

    await insertAuditLog(client, audit, {
      action: "stock.articles.documents.attach",
      entity_type: "articles",
      entity_id: articleId,
      details: {
        count: inserted.length,
        documents: inserted.map((d) => ({
          id: d.id,
          original_name: d.original_name,
          mime_type: d.mime_type,
          size_bytes: d.size_bytes,
        })),
      },
    });

    await client.query("COMMIT");
    return repoListArticleDocuments(articleId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoRemoveArticleDocument(
  articleId: string,
  documentId: string,
  audit: AuditContext
): Promise<boolean | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.articles WHERE id = $1::uuid FOR UPDATE`,
      [articleId]
    );
    if (!exists.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const del = await client.query(
      `DELETE FROM public.article_documents WHERE article_id = $1::uuid AND document_id = $2::uuid`,
      [articleId, documentId]
    );
    const removed = (del.rowCount ?? 0) > 0;
    if (!removed) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(
      `UPDATE public.stock_documents SET removed_at = now(), removed_by = $2, updated_at = now(), updated_by = $2 WHERE id = $1::uuid AND removed_at IS NULL`,
      [documentId, audit.user_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.articles.documents.remove",
      entity_type: "stock_documents",
      entity_id: documentId,
      details: { article_id: articleId },
    });

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoGetArticleDocumentForDownload(
  articleId: string,
  documentId: string,
  audit: AuditContext
): Promise<{ storage_path: string; mime_type: string; original_name: string } | null> {
  const res = await db.query<{ storage_path: string; mime_type: string; original_name: string }>(
    `
      SELECT
        sd.storage_path,
        sd.mime_type,
        sd.original_name
      FROM public.article_documents ad
      JOIN public.stock_documents sd ON sd.id = ad.document_id
      WHERE ad.article_id = $1::uuid
        AND ad.document_id = $2::uuid
        AND sd.removed_at IS NULL
      LIMIT 1
    `,
    [articleId, documentId]
  );
  const row = res.rows[0] ?? null;
  if (!row) return null;

  await insertAuditLog(db, audit, {
    action: "stock.articles.documents.download",
    entity_type: "stock_documents",
    entity_id: documentId,
    details: { article_id: articleId, original_name: row.original_name },
  });

  return row;
}

export async function repoListMovementDocuments(movementId: string): Promise<StockDocument[] | null> {
  const exists = await db.query<{ ok: number }>(
    `SELECT 1::int AS ok FROM public.stock_movements WHERE id = $1::uuid`,
    [movementId]
  );
  if (!exists.rows[0]?.ok) return null;

  const res = await db.query<StockDocument>(
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
    [movementId]
  );
  return res.rows;
}

export async function repoAttachMovementDocuments(
  movementId: string,
  documents: UploadedDocument[],
  audit: AuditContext
): Promise<StockDocument[] | null> {
  const client = await db.connect();
  const docsDirRel = path.posix.join("uploads", "docs", "stock", "movements");
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.stock_movements WHERE id = $1::uuid FOR UPDATE`,
      [movementId]
    );
    if (!exists.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const inserted = await insertStockDocuments(client, documents, audit, docsDirRel);
    for (const d of inserted) {
      await client.query(
        `
          INSERT INTO public.stock_movement_documents (stock_movement_id, document_id, type, version, uploaded_by, created_by, updated_by)
          VALUES ($1::uuid,$2::uuid,$3,$4,$5,$5,$5)
          ON CONFLICT DO NOTHING
        `,
        [movementId, d.id, null, 1, audit.user_id]
      );
    }

    await insertAuditLog(client, audit, {
      action: "stock.movements.documents.attach",
      entity_type: "stock_movements",
      entity_id: movementId,
      details: {
        count: inserted.length,
        documents: inserted.map((d) => ({
          id: d.id,
          original_name: d.original_name,
          mime_type: d.mime_type,
          size_bytes: d.size_bytes,
        })),
      },
    });

    await client.query("COMMIT");
    return repoListMovementDocuments(movementId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoRemoveMovementDocument(
  movementId: string,
  documentId: string,
  audit: AuditContext
): Promise<boolean | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.stock_movements WHERE id = $1::uuid FOR UPDATE`,
      [movementId]
    );
    if (!exists.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const del = await client.query(
      `DELETE FROM public.stock_movement_documents WHERE stock_movement_id = $1::uuid AND document_id = $2::uuid`,
      [movementId, documentId]
    );
    const removed = (del.rowCount ?? 0) > 0;
    if (!removed) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(
      `UPDATE public.stock_documents SET removed_at = now(), removed_by = $2, updated_at = now(), updated_by = $2 WHERE id = $1::uuid AND removed_at IS NULL`,
      [documentId, audit.user_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.movements.documents.remove",
      entity_type: "stock_documents",
      entity_id: documentId,
      details: { stock_movement_id: movementId },
    });

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoGetMovementDocumentForDownload(
  movementId: string,
  documentId: string,
  audit: AuditContext
): Promise<{ storage_path: string; mime_type: string; original_name: string } | null> {
  const res = await db.query<{ storage_path: string; mime_type: string; original_name: string }>(
    `
      SELECT
        sd.storage_path,
        sd.mime_type,
        sd.original_name
      FROM public.stock_movement_documents md
      JOIN public.stock_documents sd ON sd.id = md.document_id
      WHERE md.stock_movement_id = $1::uuid
        AND md.document_id = $2::uuid
        AND sd.removed_at IS NULL
      LIMIT 1
    `,
    [movementId, documentId]
  );
  const row = res.rows[0] ?? null;
  if (!row) return null;

  await insertAuditLog(db, audit, {
    action: "stock.movements.documents.download",
    entity_type: "stock_documents",
    entity_id: documentId,
    details: { stock_movement_id: movementId, original_name: row.original_name },
  });

  return row;
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
      s.started_at::text AS started_at,
      s.closed_at::text AS closed_at,
      s.notes,
      s.updated_at::text AS updated_at,
      s.created_at::text AS created_at,
      COALESCE(agg.adjustment_movements_count, 0)::int AS adjustment_movements_count,
      last.last_adjustment_movement_id
    FROM public.stock_inventory_sessions s
    LEFT JOIN (
      SELECT session_id, COUNT(*)::int AS adjustment_movements_count
      FROM public.stock_inventory_session_movements
      GROUP BY session_id
    ) agg ON agg.session_id = s.id
    LEFT JOIN LATERAL (
      SELECT sim.stock_movement_id::text AS last_adjustment_movement_id
      FROM public.stock_inventory_session_movements sim
      WHERE sim.session_id = s.id
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
  audit: AuditContext
): Promise<StockInventorySessionListItem> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const sessionNo = await reserveInventorySessionNo(client);
    const ins = await client.query<{ id: string }>(
      `
        INSERT INTO public.stock_inventory_sessions (session_no, status, notes, created_by, updated_by)
        VALUES ($1,'OPEN',$2,$3,$3)
        RETURNING id::text AS id
      `,
      [sessionNo, body.notes ?? null, audit.user_id]
    );
    const id = ins.rows[0]?.id;
    if (!id) throw new Error("Failed to create inventory session");

    await insertAuditLog(client, audit, {
      action: "stock.inventory_sessions.create",
      entity_type: "stock_inventory_sessions",
      entity_id: id,
      details: { session_no: sessionNo },
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

async function repoGetInventorySessionRow(id: string): Promise<StockInventorySessionListItem | null> {
  const res = await db.query<StockInventorySessionListItem>(
    `
      SELECT
        s.id::text AS id,
        s.session_no,
        s.status,
        s.started_at::text AS started_at,
        s.closed_at::text AS closed_at,
        s.notes,
        s.updated_at::text AS updated_at,
        s.created_at::text AS created_at,
        COALESCE(agg.adjustment_movements_count, 0)::int AS adjustment_movements_count,
        last.last_adjustment_movement_id
      FROM public.stock_inventory_sessions s
      LEFT JOIN (
        SELECT session_id, COUNT(*)::int AS adjustment_movements_count
        FROM public.stock_inventory_session_movements
        GROUP BY session_id
      ) agg ON agg.session_id = s.id
      LEFT JOIN LATERAL (
        SELECT sim.stock_movement_id::text AS last_adjustment_movement_id
        FROM public.stock_inventory_session_movements sim
        WHERE sim.session_id = s.id
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
      SELECT stock_movement_id::text AS id
      FROM public.stock_inventory_session_movements
      WHERE session_id = $1::uuid
      ORDER BY created_at ASC, id ASC
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
  const session = await db.query<{ ok: number }>(
    `SELECT 1::int AS ok FROM public.stock_inventory_sessions WHERE id = $1::uuid`,
    [id]
  );
  if (!session.rows[0]?.ok) return null;

  const res = await db.query<StockInventorySessionLine>(
    `
      SELECT
        l.id::text AS id,
        l.session_id::text AS session_id,
        l.line_no::int AS line_no,
        l.article_id::text AS article_id,
        a.code AS article_code,
        a.designation AS article_designation,
        l.magasin_id::text AS magasin_id,
        COALESCE(m.code, m.code_magasin)::text AS magasin_code,
        COALESCE(m.name, m.libelle)::text AS magasin_name,
        l.emplacement_id::int AS emplacement_id,
        e.code AS emplacement_code,
        e.name AS emplacement_name,
        l.lot_id::text AS lot_id,
        lot.lot_code AS lot_code,
        l.counted_qty::float8 AS counted_qty,
        (
          CASE
            WHEN l.lot_id IS NOT NULL THEN COALESCE(sb.qty_total, 0)
            ELSE COALESCE(sl.qty_total, 0)
          END
        )::float8 AS qty_on_hand,
        (
          l.counted_qty - (
            CASE
              WHEN l.lot_id IS NOT NULL THEN COALESCE(sb.qty_total, 0)
              ELSE COALESCE(sl.qty_total, 0)
            END
          )
        )::float8 AS delta_qty,
        l.note,
        l.updated_at::text AS updated_at,
        l.created_at::text AS created_at
      FROM public.stock_inventory_lines l
      JOIN public.articles a ON a.id = l.article_id
      JOIN public.magasins m ON m.id = l.magasin_id
      JOIN public.emplacements e ON e.id = l.emplacement_id
      LEFT JOIN public.lots lot ON lot.id = l.lot_id
      LEFT JOIN public.stock_levels sl ON sl.article_id = l.article_id AND sl.location_id = e.location_id
      LEFT JOIN public.stock_batches sb ON sb.stock_level_id = sl.id AND sb.batch_code = lot.lot_code
      WHERE l.session_id = $1::uuid
      ORDER BY l.line_no ASC, l.id ASC
    `,
    [id]
  );

  return res.rows;
}

async function repoGetInventoryLineById(lineId: string): Promise<StockInventorySessionLine | null> {
  const res = await db.query<StockInventorySessionLine>(
    `
      SELECT
        l.id::text AS id,
        l.session_id::text AS session_id,
        l.line_no::int AS line_no,
        l.article_id::text AS article_id,
        a.code AS article_code,
        a.designation AS article_designation,
        l.magasin_id::text AS magasin_id,
        COALESCE(m.code, m.code_magasin)::text AS magasin_code,
        COALESCE(m.name, m.libelle)::text AS magasin_name,
        l.emplacement_id::int AS emplacement_id,
        e.code AS emplacement_code,
        e.name AS emplacement_name,
        l.lot_id::text AS lot_id,
        lot.lot_code AS lot_code,
        l.counted_qty::float8 AS counted_qty,
        (
          CASE
            WHEN l.lot_id IS NOT NULL THEN COALESCE(sb.qty_total, 0)
            ELSE COALESCE(sl.qty_total, 0)
          END
        )::float8 AS qty_on_hand,
        (
          l.counted_qty - (
            CASE
              WHEN l.lot_id IS NOT NULL THEN COALESCE(sb.qty_total, 0)
              ELSE COALESCE(sl.qty_total, 0)
            END
          )
        )::float8 AS delta_qty,
        l.note,
        l.updated_at::text AS updated_at,
        l.created_at::text AS created_at
      FROM public.stock_inventory_lines l
      JOIN public.articles a ON a.id = l.article_id
      JOIN public.magasins m ON m.id = l.magasin_id
      JOIN public.emplacements e ON e.id = l.emplacement_id
      LEFT JOIN public.lots lot ON lot.id = l.lot_id
      LEFT JOIN public.stock_levels sl ON sl.article_id = l.article_id AND sl.location_id = e.location_id
      LEFT JOIN public.stock_batches sb ON sb.stock_level_id = sl.id AND sb.batch_code = lot.lot_code
      WHERE l.id = $1::uuid
      LIMIT 1
    `,
    [lineId]
  );
  return res.rows[0] ?? null;
}

export async function repoUpsertInventoryLine(
  sessionId: string,
  body: UpsertInventoryLineBodyDTO,
  audit: AuditContext
): Promise<StockInventorySessionLine | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const lock = await client.query<{ status: string }>(
      `SELECT status FROM public.stock_inventory_sessions WHERE id = $1::uuid FOR UPDATE`,
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
      const next = await client.query<{ n: number }>(
        `SELECT (COALESCE(MAX(line_no), 0) + 1)::int AS n FROM public.stock_inventory_lines WHERE session_id = $1::uuid`,
        [sessionId]
      );
      const lineNo = next.rows[0]?.n;
      if (!lineNo) throw new Error("Failed to allocate inventory line number");

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
          lineNo,
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

    await insertAuditLog(client, audit, {
      action: "stock.inventory_sessions.lines.upsert",
      entity_type: "stock_inventory_lines",
      entity_id: lineId,
      details: {
        session_id: sessionId,
        article_id: body.article_id,
        magasin_id: body.magasin_id,
        emplacement_id: body.emplacement_id,
        lot_id: body.lot_id ?? null,
        counted_qty: body.counted_qty,
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

export async function repoCloseInventorySession(id: string, audit: AuditContext): Promise<StockInventorySessionDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const lock = await client.query<{ status: string; session_no: string }>(
      `SELECT status, session_no FROM public.stock_inventory_sessions WHERE id = $1::uuid FOR UPDATE`,
      [id]
    );
    const s = lock.rows[0] ?? null;
    if (!s) {
      await client.query("ROLLBACK");
      return null;
    }
    if (s.status !== "OPEN") {
      throw new HttpError(409, "INVALID_STATUS", "Only OPEN sessions can be closed");
    }

    const lines = await client.query<StockInventorySessionLine>(
      `
        SELECT
          l.id::text AS id,
          l.session_id::text AS session_id,
          l.line_no::int AS line_no,
          l.article_id::text AS article_id,
          a.code AS article_code,
          a.designation AS article_designation,
          l.magasin_id::text AS magasin_id,
          COALESCE(m.code, m.code_magasin)::text AS magasin_code,
          COALESCE(m.name, m.libelle)::text AS magasin_name,
          l.emplacement_id::int AS emplacement_id,
          e.code AS emplacement_code,
          e.name AS emplacement_name,
          l.lot_id::text AS lot_id,
          lot.lot_code AS lot_code,
          l.counted_qty::float8 AS counted_qty,
          (
            CASE
              WHEN l.lot_id IS NOT NULL THEN COALESCE(sb.qty_total, 0)
              ELSE COALESCE(sl.qty_total, 0)
            END
          )::float8 AS qty_on_hand,
          (
            l.counted_qty - (
              CASE
                WHEN l.lot_id IS NOT NULL THEN COALESCE(sb.qty_total, 0)
                ELSE COALESCE(sl.qty_total, 0)
              END
            )
          )::float8 AS delta_qty,
          l.note,
          l.updated_at::text AS updated_at,
          l.created_at::text AS created_at
        FROM public.stock_inventory_lines l
        JOIN public.articles a ON a.id = l.article_id
        JOIN public.magasins m ON m.id = l.magasin_id
        JOIN public.emplacements e ON e.id = l.emplacement_id
        LEFT JOIN public.lots lot ON lot.id = l.lot_id
        LEFT JOIN public.stock_levels sl ON sl.article_id = l.article_id AND sl.location_id = e.location_id
        LEFT JOIN public.stock_batches sb ON sb.stock_level_id = sl.id AND sb.batch_code = lot.lot_code
        WHERE l.session_id = $1::uuid
        ORDER BY l.line_no ASC
      `,
      [id]
    );

    const adjustments = lines.rows.filter((l) => Math.abs(l.delta_qty) > 1e-9);
    const postedAt = new Date().toISOString();
    const unitCache = new Map<string, string>();

    for (const adj of adjustments) {
      const delta = adj.delta_qty;
      const direction: "IN" | "OUT" = delta > 0 ? "IN" : "OUT";

      let unitId = unitCache.get(adj.article_id);
      if (!unitId) {
        unitId = await resolveUnitIdForArticle(client, adj.article_id, null);
        unitCache.set(adj.article_id, unitId);
      }

      const map = await getEmplacementMapping(client, adj.magasin_id, adj.emplacement_id, direction === "IN" ? "dst" : "src");
      const stockLevelId = await ensureStockLevel(client, {
        article_id: adj.article_id,
        unit_id: unitId,
        warehouse_id: map.warehouse_id,
        location_id: map.location_id,
        actor_user_id: audit.user_id,
      });

      const stockBatchId = adj.lot_id ? await ensureStockBatchId(client, { stock_level_id: stockLevelId, lot_id: adj.lot_id }) : null;
      const movementNo = await reserveMovementNo(client);

      const movement = await client.query<{ id: string }>(
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
            source_document_type,
            source_document_id,
            reason_code,
            notes,
            user_id,
            created_by,
            updated_by
          )
          VALUES ($1,'ADJUSTMENT','POSTED',$2::uuid,$3::uuid,$4::uuid,$5,'EUR',now(),$6,$7,$8,$9,'INVENTORY', $10,$7,$7,$7)
          RETURNING id::text AS id
        `,
        [
          movementNo,
          adj.article_id,
          stockLevelId,
          stockBatchId,
          delta,
          postedAt,
          audit.user_id,
          "stock_inventory_session",
          id,
          `inventory ${s.session_no}`,
        ]
      );
      const movementId = movement.rows[0]?.id;
      if (!movementId) throw new Error("Failed to create adjustment movement");

      await client.query(
        `
          INSERT INTO public.stock_movement_lines (
            movement_id, line_no, article_id, lot_id,
            qty, unite,
            src_magasin_id, src_emplacement_id,
            dst_magasin_id, dst_emplacement_id,
            direction,
            note,
            created_by, updated_by
          )
          VALUES ($1::uuid,1,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::bigint,$8::uuid,$9::bigint,$10,$11,$12,$12)
        `,
        [
          movementId,
          adj.article_id,
          adj.lot_id ?? null,
          Math.abs(delta),
          null,
          direction === "OUT" ? adj.magasin_id : null,
          direction === "OUT" ? adj.emplacement_id : null,
          direction === "IN" ? adj.magasin_id : null,
          direction === "IN" ? adj.emplacement_id : null,
          direction,
          adj.note ?? null,
          audit.user_id,
        ]
      );

      await insertMovementEvent(client, {
        movement_id: movementId,
        event_type: "CREATED_POSTED",
        old_values: null,
        new_values: { status: "POSTED", movement_type: "ADJUSTMENT", delta },
        user_id: audit.user_id,
      });

      await client.query(
        `
          INSERT INTO public.stock_inventory_session_movements (session_id, stock_movement_id)
          VALUES ($1::uuid,$2::uuid)
          ON CONFLICT DO NOTHING
        `,
        [id, movementId]
      );
    }

    await client.query(
      `
        UPDATE public.stock_inventory_sessions
        SET status = 'CLOSED', closed_at = now(), closed_by = $2, updated_at = now(), updated_by = $2
        WHERE id = $1::uuid
      `,
      [id, audit.user_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.inventory_sessions.close",
      entity_type: "stock_inventory_sessions",
      entity_id: id,
      details: {
        session_no: s.session_no,
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
