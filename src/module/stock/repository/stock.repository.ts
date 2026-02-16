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
  StockLotDetail,
  StockLotListItem,
  StockMagasinDetail,
  StockMagasinKpis,
  StockMagasinListItem,
  StockMovementDetail,
  StockMovementEvent,
  StockMovementKpis,
  StockMovementLineDetail,
  StockMovementListItem,
} from "../types/stock.types";
import type {
  CreateArticleBodyDTO,
  CreateEmplacementBodyDTO,
  CreateLotBodyDTO,
  CreateMagasinBodyDTO,
  CreateMovementBodyDTO,
  CreateMovementLineDTO,
  ListArticlesQueryDTO,
  ListBalancesQueryDTO,
  ListEmplacementsQueryDTO,
  ListLotsQueryDTO,
  ListMagasinsQueryDTO,
  ListMovementsQueryDTO,
  StockMovementTypeDTO,
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
      return "m.code";
    case "name":
      return "m.name";
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

function normalizeLikeQuery(raw: string): string {
  return `%${raw.trim()}%`;
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
      a.id::int AS id,
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

export async function repoGetArticle(id: number): Promise<StockArticleDetail | null> {
  const res = await db.query<StockArticleDetail>(
    `
      SELECT
        a.id::int AS id,
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
      WHERE a.id = $1
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
  const createdBy = audit.user_id;
  const updatedBy = audit.user_id;

  try {
    const res = await db.query<{ id: number }>(
      `
        INSERT INTO public.articles (
          code, designation, article_type, piece_technique_id, unite,
          lot_tracking, is_active, notes,
          created_by, updated_by
        )
        VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10)
        RETURNING id::int AS id
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
        createdBy,
        updatedBy,
      ]
    );

    const id = res.rows[0]?.id;
    if (!id) throw new Error("Failed to create article");
    const out = await repoGetArticle(id);
    if (!out) throw new Error("Failed to read created article");

    await insertAuditLog(db, audit, {
      action: "stock.articles.create",
      entity_type: "articles",
      entity_id: String(id),
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
  id: number,
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
    WHERE id = ${push(id)}
    RETURNING id::int AS id
  `;

  try {
    const res = await db.query<{ id: number }>(sql, values);
    const rowId = res.rows[0]?.id;
    if (!rowId) return null;

    await insertAuditLog(db, audit, {
      action: "stock.articles.update",
      entity_type: "articles",
      entity_id: String(id),
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
    where.push(`(m.code ILIKE ${p} OR m.name ILIKE ${p})`);
  }
  if (filters.is_active !== undefined) where.push(`m.is_active = ${push(filters.is_active)}`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = magasinSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM public.magasins m ${whereSql}`, values);
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      m.id::int AS id,
      m.code,
      m.name,
      m.is_active,
      m.updated_at::text AS updated_at,
      m.created_at::text AS created_at,
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

export async function repoGetMagasin(id: number): Promise<StockMagasinDetail | null> {
  const m = await db.query<StockMagasinDetail["magasin"]>(
    `
      SELECT
        id::int AS id,
        code,
        name,
        is_active,
        notes,
        updated_at::text AS updated_at,
        created_at::text AS created_at
      FROM public.magasins
      WHERE id = $1
    `,
    [id]
  );

  const magasin = m.rows[0] ?? null;
  if (!magasin) return null;

  const e = await db.query<StockEmplacementListItem>(
    `
      SELECT
        e.id::int AS id,
        e.magasin_id::int AS magasin_id,
        m.code AS magasin_code,
        m.name AS magasin_name,
        e.code,
        e.name,
        e.is_scrap,
        e.is_active,
        e.updated_at::text AS updated_at,
        e.created_at::text AS created_at
      FROM public.emplacements e
      JOIN public.magasins m ON m.id = e.magasin_id
      WHERE e.magasin_id = $1
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
    const res = await db.query<{ id: number }>(
      `
        INSERT INTO public.magasins (code, name, is_active, notes, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id::int AS id
      `,
      [body.code, body.name, body.is_active, body.notes ?? null, audit.user_id, audit.user_id]
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error("Failed to create magasin");

    await insertAuditLog(db, audit, {
      action: "stock.magasins.create",
      entity_type: "magasins",
      entity_id: String(id),
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
  id: number,
  patch: UpdateMagasinBodyDTO,
  audit: AuditContext
): Promise<StockMagasinDetail["magasin"] | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (patch.code !== undefined) sets.push(`code = ${push(patch.code)}`);
  if (patch.name !== undefined) sets.push(`name = ${push(patch.name)}`);
  if (patch.is_active !== undefined) sets.push(`is_active = ${push(patch.is_active)}`);
  if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`);
  sets.push(`updated_at = now()`);
  sets.push(`updated_by = ${push(audit.user_id)}`);

  const res = await db.query<{ id: number }>(
    `UPDATE public.magasins SET ${sets.join(", ")} WHERE id = ${push(id)} RETURNING id::int AS id`,
    values
  );
  if (!res.rows[0]?.id) return null;

  await insertAuditLog(db, audit, {
    action: "stock.magasins.update",
    entity_type: "magasins",
    entity_id: String(id),
    details: { patch },
  });

  const out = await repoGetMagasin(id);
  return out?.magasin ?? null;
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

  if (filters.magasin_id) where.push(`e.magasin_id = ${push(filters.magasin_id)}`);
  if (filters.is_active !== undefined) where.push(`e.is_active = ${push(filters.is_active)}`);
  if (filters.is_scrap !== undefined) where.push(`e.is_scrap = ${push(filters.is_scrap)}`);
  if (filters.q && filters.q.trim().length > 0) {
    const q = normalizeLikeQuery(filters.q);
    const p = push(q);
    where.push(`(e.code ILIKE ${p} OR COALESCE(e.name, '') ILIKE ${p} OR m.code ILIKE ${p} OR m.name ILIKE ${p})`);
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
      e.magasin_id::int AS magasin_id,
      m.code AS magasin_code,
      m.name AS magasin_name,
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
  magasinId: number,
  body: CreateEmplacementBodyDTO,
  audit: AuditContext
): Promise<StockEmplacementListItem | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const mag = await client.query<{ ok: number; code: string; name: string }>(
      `SELECT 1::int AS ok, code, name FROM public.magasins WHERE id = $1 FOR UPDATE`,
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
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id::int AS id
      `,
      [
        magasinId,
        body.code,
        body.name ?? null,
        body.is_scrap,
        body.is_active,
        body.notes ?? null,
        audit.user_id,
        audit.user_id,
      ]
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
          e.magasin_id::int AS magasin_id,
          m.code AS magasin_code,
          m.name AS magasin_name,
          e.code,
          e.name,
          e.is_scrap,
          e.is_active,
          e.updated_at::text AS updated_at,
          e.created_at::text AS created_at
        FROM public.emplacements e
        JOIN public.magasins m ON m.id = e.magasin_id
        WHERE e.id = $1
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
      `UPDATE public.emplacements SET ${sets.join(", ")} WHERE id = ${push(id)} RETURNING id::int AS id`,
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
          e.magasin_id::int AS magasin_id,
          m.code AS magasin_code,
          m.name AS magasin_name,
          e.code,
          e.name,
          e.is_scrap,
          e.is_active,
          e.updated_at::text AS updated_at,
          e.created_at::text AS created_at
        FROM public.emplacements e
        JOIN public.magasins m ON m.id = e.magasin_id
        WHERE e.id = $1
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

  if (filters.article_id) where.push(`l.article_id = ${push(filters.article_id)}`);
  if (filters.q && filters.q.trim().length > 0) {
    const q = normalizeLikeQuery(filters.q);
    const p = push(q);
    where.push(`(l.lot_code ILIKE ${p} OR COALESCE(l.supplier_lot_code, '') ILIKE ${p} OR a.code ILIKE ${p} OR a.designation ILIKE ${p})`);
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
      l.id::int AS id,
      l.article_id::int AS article_id,
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

export async function repoGetLot(id: number): Promise<StockLotDetail | null> {
  const res = await db.query<StockLotDetail>(
    `
      SELECT
        l.id::int AS id,
        l.article_id::int AS article_id,
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
      WHERE l.id = $1
    `,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function repoCreateLot(body: CreateLotBodyDTO, audit: AuditContext): Promise<StockLotDetail> {
  try {
    const res = await db.query<{ id: number }>(
      `
        INSERT INTO public.lots (
          article_id, lot_code, supplier_lot_code,
          received_at, manufactured_at, expiry_at,
          notes, created_by, updated_by
        )
        VALUES ($1,$2,$3,$4::date,$5::date,$6::date,$7,$8,$9)
        RETURNING id::int AS id
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
        audit.user_id,
      ]
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error("Failed to create lot");

    await insertAuditLog(db, audit, {
      action: "stock.lots.create",
      entity_type: "lots",
      entity_id: String(id),
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

export async function repoUpdateLot(id: number, patch: UpdateLotBodyDTO, audit: AuditContext): Promise<StockLotDetail | null> {
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
    const res = await db.query<{ id: number }>(
      `UPDATE public.lots SET ${sets.join(", ")} WHERE id = ${push(id)} RETURNING id::int AS id`,
      values
    );
    if (!res.rows[0]?.id) return null;

    await insertAuditLog(db, audit, {
      action: "stock.lots.update",
      entity_type: "lots",
      entity_id: String(id),
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

  if (filters.article_id) where.push(`b.article_id = ${push(filters.article_id)}`);
  if (filters.magasin_id) where.push(`b.magasin_id = ${push(filters.magasin_id)}`);
  if (filters.emplacement_id) where.push(`b.emplacement_id = ${push(filters.emplacement_id)}`);
  if (filters.lot_id) where.push(`b.lot_id = ${push(filters.lot_id)}`);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countRes = await db.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM public.stock_balances b ${whereSql}`, values);
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      b.article_id::int AS article_id,
      a.code AS article_code,
      a.designation AS article_designation,
      b.magasin_id::int AS magasin_id,
      m.code AS magasin_code,
      m.name AS magasin_name,
      b.emplacement_id::int AS emplacement_id,
      e.code AS emplacement_code,
      e.name AS emplacement_name,
      b.lot_id::int AS lot_id,
      l.lot_code AS lot_code,
      b.qty_on_hand::float8 AS qty_on_hand,
      b.updated_at::text AS updated_at
    FROM public.stock_balances b
    JOIN public.articles a ON a.id = b.article_id
    JOIN public.magasins m ON m.id = b.magasin_id
    JOIN public.emplacements e ON e.id = b.emplacement_id
    LEFT JOIN public.lots l ON l.id = b.lot_id
    ${whereSql}
    ORDER BY a.code ASC, m.code ASC, e.code ASC, l.lot_code NULLS FIRST
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockBalanceRow>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
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

export async function repoListMovements(filters: ListMovementsQueryDTO): Promise<Paginated<StockMovementListItem>> {
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
    where.push(`(m.movement_no ILIKE ${p} OR COALESCE(m.source_document_id, '') ILIKE ${p})`);
  }
  if (filters.movement_type) where.push(`m.movement_type = ${push(filters.movement_type)}`);
  if (filters.status) where.push(`m.status = ${push(filters.status)}`);
  if (filters.article_id) {
    where.push(
      `EXISTS (SELECT 1 FROM public.stock_movement_lines l WHERE l.movement_id = m.id AND l.article_id = ${push(filters.article_id)})`
    );
  }
  if (filters.from) where.push(`m.effective_at >= ${push(filters.from)}::timestamptz`);
  if (filters.to) where.push(`m.effective_at <= ${push(filters.to)}::timestamptz`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = movementSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM public.stock_movements m ${whereSql}`, values);
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      m.id::int AS id,
      m.movement_no,
      m.movement_type,
      m.status,
      m.effective_at::text AS effective_at,
      m.posted_at::text AS posted_at,
      m.source_document_type,
      m.source_document_id,
      m.reason_code,
      m.updated_at::text AS updated_at,
      m.created_at::text AS created_at,
      COALESCE(agg.lines_count, 0)::int AS lines_count,
      COALESCE(agg.qty_total, 0)::float8 AS qty_total
    FROM public.stock_movements m
    LEFT JOIN (
      SELECT
        movement_id,
        COUNT(*)::int AS lines_count,
        COALESCE(SUM(qty), 0)::float8 AS qty_total
      FROM public.stock_movement_lines
      GROUP BY movement_id
    ) agg ON agg.movement_id = m.id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockMovementListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

type MovementRow = StockMovementDetail["movement"] & {
  created_by: number | null;
  updated_by: number | null;
  posted_by: number | null;
};

export async function repoGetMovement(id: number): Promise<StockMovementDetail | null> {
  const m = await db.query<MovementRow>(
    `
      SELECT
        id::int AS id,
        movement_no,
        movement_type,
        status,
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
      WHERE id = $1
    `,
    [id]
  );
  const movement = m.rows[0] ?? null;
  if (!movement) return null;

  const l = await db.query<StockMovementLineDetail>(
    `
      SELECT
        l.id::int AS id,
        l.movement_id::int AS movement_id,
        l.line_no::int AS line_no,
        l.article_id::int AS article_id,
        a.code AS article_code,
        a.designation AS article_designation,
        l.lot_id::int AS lot_id,
        lot.lot_code AS lot_code,
        l.qty::float8 AS qty,
        l.unite,
        l.unit_cost::float8 AS unit_cost,
        l.currency,
        l.src_magasin_id::int AS src_magasin_id,
        sm.code AS src_magasin_code,
        sm.name AS src_magasin_name,
        l.src_emplacement_id::int AS src_emplacement_id,
        se.code AS src_emplacement_code,
        se.name AS src_emplacement_name,
        l.dst_magasin_id::int AS dst_magasin_id,
        dm.code AS dst_magasin_code,
        dm.name AS dst_magasin_name,
        l.dst_emplacement_id::int AS dst_emplacement_id,
        de.code AS dst_emplacement_code,
        de.name AS dst_emplacement_name,
        l.note
      FROM public.stock_movement_lines l
      JOIN public.articles a ON a.id = l.article_id
      LEFT JOIN public.lots lot ON lot.id = l.lot_id
      LEFT JOIN public.magasins sm ON sm.id = l.src_magasin_id
      LEFT JOIN public.emplacements se ON se.id = l.src_emplacement_id
      LEFT JOIN public.magasins dm ON dm.id = l.dst_magasin_id
      LEFT JOIN public.emplacements de ON de.id = l.dst_emplacement_id
      WHERE l.movement_id = $1
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
      WHERE md.stock_movement_id = $1
        AND sd.removed_at IS NULL
      ORDER BY md.created_at DESC, md.id DESC
    `,
    [id]
  );

  const events = await db.query<StockMovementEvent>(
    `
      SELECT
        id::int AS id,
        stock_movement_id::int AS stock_movement_id,
        event_type,
        old_values,
        new_values,
        user_id,
        created_at::text AS created_at
      FROM public.stock_movement_event_log
      WHERE stock_movement_id = $1
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

type BalanceKey = {
  article_id: number;
  magasin_id: number;
  emplacement_id: number;
  lot_id: number | null;
};

function balanceKeySort(a: BalanceKey, b: BalanceKey): number {
  if (a.article_id !== b.article_id) return a.article_id - b.article_id;
  if (a.magasin_id !== b.magasin_id) return a.magasin_id - b.magasin_id;
  if (a.emplacement_id !== b.emplacement_id) return a.emplacement_id - b.emplacement_id;
  if (a.lot_id === b.lot_id) return 0;
  if (a.lot_id === null) return 1;
  if (b.lot_id === null) return -1;
  return a.lot_id - b.lot_id;
}

function uniqueBalanceKeys(keys: BalanceKey[]): BalanceKey[] {
  const map = new Map<string, BalanceKey>();
  for (const k of keys) {
    const key = `${k.article_id}|${k.magasin_id}|${k.emplacement_id}|${k.lot_id ?? ""}`;
    if (!map.has(key)) map.set(key, k);
  }
  return Array.from(map.values()).sort(balanceKeySort);
}

function assertLineHasLocation(line: CreateMovementLineDTO, movementType: StockMovementTypeDTO) {
  const srcOk = !!(line.src_magasin_id && line.src_emplacement_id);
  const dstOk = !!(line.dst_magasin_id && line.dst_emplacement_id);

  switch (movementType) {
    case "IN":
      if (!dstOk) throw new HttpError(400, "INVALID_LINE", "IN line requires dst_magasin_id and dst_emplacement_id");
      break;
    case "OUT":
      if (!srcOk) throw new HttpError(400, "INVALID_LINE", "OUT line requires src_magasin_id and src_emplacement_id");
      break;
    case "TRANSFER":
      if (!srcOk || !dstOk) {
        throw new HttpError(400, "INVALID_LINE", "TRANSFER line requires both src_* and dst_* location fields");
      }
      break;
    case "SCRAP":
      if (!srcOk) throw new HttpError(400, "INVALID_LINE", "SCRAP line requires src_magasin_id and src_emplacement_id");
      break;
    case "ADJUSTMENT":
      if (line.direction === "IN") {
        if (!dstOk) throw new HttpError(400, "INVALID_LINE", "ADJUSTMENT IN line requires dst_* location fields");
      } else if (line.direction === "OUT") {
        if (!srcOk) throw new HttpError(400, "INVALID_LINE", "ADJUSTMENT OUT line requires src_* location fields");
      } else {
        throw new HttpError(400, "INVALID_LINE", "ADJUSTMENT line requires direction IN or OUT");
      }
      break;
  }
}

async function assertEmplacementBelongsToMagasin(
  client: Pick<PoolClient, "query">,
  magasinId: number,
  emplacementId: number,
  label: "src" | "dst"
) {
  const res = await client.query<{ magasin_id: number }>(
    `SELECT magasin_id::int AS magasin_id FROM public.emplacements WHERE id = $1`,
    [emplacementId]
  );
  const row = res.rows[0] ?? null;
  if (!row) {
    throw new HttpError(400, "INVALID_LOCATION", `Unknown ${label}_emplacement_id`);
  }
  if (row.magasin_id !== magasinId) {
    throw new HttpError(400, "INVALID_LOCATION", `${label}_emplacement_id does not belong to ${label}_magasin_id`);
  }
}

export async function repoCreateMovement(body: CreateMovementBodyDTO, audit: AuditContext): Promise<StockMovementDetail> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const movementNo = await reserveMovementNo(client);
    const effectiveAt = body.effective_at ? new Date(body.effective_at) : new Date();
    if (Number.isNaN(effectiveAt.getTime())) {
      throw new HttpError(400, "INVALID_EFFECTIVE_AT", "Invalid effective_at");
    }

    const insertMovementSql = `
      INSERT INTO public.stock_movements (
        movement_no, movement_type, status,
        effective_at,
        source_document_type, source_document_id,
        reason_code, notes,
        idempotency_key,
        created_by, updated_by
      )
      VALUES ($1,$2,'DRAFT',$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id::int AS id
    `;

    let movementId: number;
    try {
      const ins = await client.query<{ id: number }>(insertMovementSql, [
        movementNo,
        body.movement_type,
        effectiveAt.toISOString(),
        body.source_document_type ?? null,
        body.source_document_id ?? null,
        body.reason_code ?? null,
        body.notes ?? null,
        body.idempotency_key ?? null,
        audit.user_id,
        audit.user_id,
      ]);
      movementId = ins.rows[0]?.id ?? 0;
      if (!movementId) throw new Error("Failed to create movement");
    } catch (err) {
      if (body.idempotency_key && isPgUniqueViolation(err)) {
        const existing = await client.query<{ id: number }>(
          `SELECT id::int AS id FROM public.stock_movements WHERE idempotency_key = $1`,
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
      assertLineHasLocation(line, body.movement_type);

      if (line.src_magasin_id && line.src_emplacement_id) {
        await assertEmplacementBelongsToMagasin(client, line.src_magasin_id, line.src_emplacement_id, "src");
      }
      if (line.dst_magasin_id && line.dst_emplacement_id) {
        await assertEmplacementBelongsToMagasin(client, line.dst_magasin_id, line.dst_emplacement_id, "dst");
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
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
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
          audit.user_id,
        ]
      );
    }

    await client.query(
      `
        INSERT INTO public.stock_movement_event_log (
          stock_movement_id, event_type, old_values, new_values, user_id, created_by, updated_by
        )
        VALUES ($1,'CREATED',NULL,$2::jsonb,$3,$3,$3)
      `,
      [movementId, JSON.stringify({ status: "DRAFT", movement_type: body.movement_type, lines_count: body.lines.length }), audit.user_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.movements.create",
      entity_type: "stock_movements",
      entity_id: String(movementId),
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

export async function repoCancelMovement(id: number, audit: AuditContext): Promise<StockMovementDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const lock = await client.query<{ status: string; movement_no: string }>(
      `SELECT status, movement_no FROM public.stock_movements WHERE id = $1 FOR UPDATE`,
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
      `UPDATE public.stock_movements SET status = 'CANCELLED', updated_at = now(), updated_by = $2 WHERE id = $1`,
      [id, audit.user_id]
    );

    await client.query(
      `
        INSERT INTO public.stock_movement_event_log (
          stock_movement_id, event_type, old_values, new_values, user_id, created_by, updated_by
        )
        VALUES ($1,'CANCELLED',$2::jsonb,$3::jsonb,$4,$4,$4)
      `,
      [id, JSON.stringify({ status: "DRAFT" }), JSON.stringify({ status: "CANCELLED" }), audit.user_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.movements.cancel",
      entity_type: "stock_movements",
      entity_id: String(id),
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

type BalanceRowLock = {
  id: number;
  article_id: number;
  magasin_id: number;
  emplacement_id: number;
  lot_id: number | null;
  qty_on_hand: number;
};

async function ensureAndLockBalanceRows(client: PoolClient, keys: BalanceKey[], actorUserId: number): Promise<Map<string, BalanceRowLock>> {
  const out = new Map<string, BalanceRowLock>();

  for (const k of keys) {
    // Ensure row exists.
    await client.query(
      `
        INSERT INTO public.stock_balances (article_id, magasin_id, emplacement_id, lot_id, qty_on_hand, created_by, updated_by)
        VALUES ($1,$2,$3,$4,0,$5,$5)
        ON CONFLICT DO NOTHING
      `,
      [k.article_id, k.magasin_id, k.emplacement_id, k.lot_id, actorUserId]
    );
  }

  for (const k of keys) {
    const locked = await client.query<BalanceRowLock>(
      `
        SELECT
          id::int AS id,
          article_id::int AS article_id,
          magasin_id::int AS magasin_id,
          emplacement_id::int AS emplacement_id,
          lot_id::int AS lot_id,
          qty_on_hand::float8 AS qty_on_hand
        FROM public.stock_balances
        WHERE article_id = $1 AND magasin_id = $2 AND emplacement_id = $3 AND ((lot_id IS NULL AND $4::bigint IS NULL) OR lot_id = $4)
        FOR UPDATE
      `,
      [k.article_id, k.magasin_id, k.emplacement_id, k.lot_id]
    );
    const row = locked.rows[0];
    if (!row) throw new Error("Failed to lock stock balance row");
    const key = `${row.article_id}|${row.magasin_id}|${row.emplacement_id}|${row.lot_id ?? ""}`;
    out.set(key, row);
  }
  return out;
}

type PostingLeg = {
  movement_line_id: number;
  leg_no: number;
  article_id: number;
  lot_id: number | null;
  magasin_id: number;
  emplacement_id: number;
  delta_qty: number;
};

async function assertScrapDestinationIfProvided(client: PoolClient, dstEmplacementId: number) {
  const res = await client.query<{ is_scrap: boolean }>(
    `SELECT is_scrap FROM public.emplacements WHERE id = $1`,
    [dstEmplacementId]
  );
  const isScrap = res.rows[0]?.is_scrap;
  if (isScrap !== true) {
    throw new HttpError(400, "INVALID_SCRAP_DESTINATION", "SCRAP destination emplacement must be marked as scrap");
  }
}

async function buildPostingLegs(
  client: PoolClient,
  movementType: StockMovementTypeDTO,
  lines: {
    id: number;
    article_id: number;
    lot_id: number | null;
    qty: number;
    src_magasin_id: number | null;
    src_emplacement_id: number | null;
    dst_magasin_id: number | null;
    dst_emplacement_id: number | null;
    direction: "IN" | "OUT" | null;
  }[]
): Promise<PostingLeg[]> {
  const legs: PostingLeg[] = [];
  for (const l of lines) {
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new HttpError(400, "INVALID_QTY", "Movement line qty must be > 0");
    }

    const srcMagasinId = l.src_magasin_id;
    const srcEmplacementId = l.src_emplacement_id;
    const dstMagasinId = l.dst_magasin_id;
    const dstEmplacementId = l.dst_emplacement_id;

    if (movementType === "SCRAP" && dstEmplacementId) {
      await assertScrapDestinationIfProvided(client, dstEmplacementId);
    }

    const pushLeg = (legNo: number, magasinId: number, emplacementId: number, deltaQty: number) => {
      legs.push({
        movement_line_id: l.id,
        leg_no: legNo,
        article_id: l.article_id,
        lot_id: l.lot_id,
        magasin_id: magasinId,
        emplacement_id: emplacementId,
        delta_qty: deltaQty,
      });
    };

    switch (movementType) {
      case "IN": {
        if (!dstMagasinId || !dstEmplacementId) throw new HttpError(400, "INVALID_LINE", "IN line missing destination");
        pushLeg(1, dstMagasinId, dstEmplacementId, qty);
        break;
      }
      case "OUT": {
        if (!srcMagasinId || !srcEmplacementId) throw new HttpError(400, "INVALID_LINE", "OUT line missing source");
        pushLeg(1, srcMagasinId, srcEmplacementId, -qty);
        break;
      }
      case "TRANSFER": {
        if (!srcMagasinId || !srcEmplacementId || !dstMagasinId || !dstEmplacementId) {
          throw new HttpError(400, "INVALID_LINE", "TRANSFER line missing source or destination");
        }
        pushLeg(1, srcMagasinId, srcEmplacementId, -qty);
        pushLeg(2, dstMagasinId, dstEmplacementId, qty);
        break;
      }
      case "SCRAP": {
        if (!srcMagasinId || !srcEmplacementId) throw new HttpError(400, "INVALID_LINE", "SCRAP line missing source");
        pushLeg(1, srcMagasinId, srcEmplacementId, -qty);
        if (dstMagasinId && dstEmplacementId) {
          pushLeg(2, dstMagasinId, dstEmplacementId, qty);
        }
        break;
      }
      case "ADJUSTMENT": {
        const dir = l.direction;
        if (dir === "IN") {
          if (!dstMagasinId || !dstEmplacementId) throw new HttpError(400, "INVALID_LINE", "ADJUSTMENT IN missing destination");
          pushLeg(1, dstMagasinId, dstEmplacementId, qty);
        } else if (dir === "OUT") {
          if (!srcMagasinId || !srcEmplacementId) throw new HttpError(400, "INVALID_LINE", "ADJUSTMENT OUT missing source");
          pushLeg(1, srcMagasinId, srcEmplacementId, -qty);
        } else {
          throw new HttpError(400, "INVALID_LINE", "ADJUSTMENT line requires direction IN or OUT");
        }
        break;
      }
    }
  }
  return legs;
}

export async function repoPostMovement(id: number, audit: AuditContext): Promise<StockMovementDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const lock = await client.query<{
      id: number;
      movement_no: string;
      movement_type: StockMovementTypeDTO;
      status: string;
      effective_at: string;
    }>(
      `
        SELECT
          id::int AS id,
          movement_no,
          movement_type,
          status,
          effective_at::text AS effective_at
        FROM public.stock_movements
        WHERE id = $1
        FOR UPDATE
      `,
      [id]
    );
    const movement = lock.rows[0] ?? null;
    if (!movement) {
      await client.query("ROLLBACK");
      return null;
    }
    if (movement.status !== "DRAFT") {
      throw new HttpError(409, "INVALID_STATUS", "Only DRAFT movements can be posted");
    }

    const lines = await client.query<{
      id: number;
      article_id: number;
      lot_id: number | null;
      qty: number;
      src_magasin_id: number | null;
      src_emplacement_id: number | null;
      dst_magasin_id: number | null;
      dst_emplacement_id: number | null;
      direction: "IN" | "OUT" | null;
      note: string | null;
    }>(
      `
        SELECT
          id::int AS id,
          article_id::int AS article_id,
          lot_id::int AS lot_id,
          qty::float8 AS qty,
          src_magasin_id::int AS src_magasin_id,
          src_emplacement_id::int AS src_emplacement_id,
          dst_magasin_id::int AS dst_magasin_id,
          dst_emplacement_id::int AS dst_emplacement_id,
          direction,
          note
        FROM public.stock_movement_lines
        WHERE movement_id = $1
        ORDER BY line_no ASC, id ASC
      `,
      [id]
    );
    if (!lines.rows.length) {
      throw new HttpError(400, "EMPTY_MOVEMENT", "Movement has no lines");
    }

    const legs = await buildPostingLegs(
      client,
      movement.movement_type,
      lines.rows
    );

    const keys = uniqueBalanceKeys(
      legs.map((leg) => ({
        article_id: leg.article_id,
        magasin_id: leg.magasin_id,
        emplacement_id: leg.emplacement_id,
        lot_id: leg.lot_id,
      }))
    );

    const lockedBalances = await ensureAndLockBalanceRows(client, keys, audit.user_id);

    const postedAt = new Date();
    const effectiveAt = new Date(movement.effective_at);
    if (Number.isNaN(effectiveAt.getTime())) {
      throw new HttpError(400, "INVALID_EFFECTIVE_AT", "Invalid effective_at");
    }

    // Apply legs in deterministic order (by balance key order, then by movement line, then by leg_no).
    const legsOrdered = [...legs].sort((a, b) => {
      const ka: BalanceKey = { article_id: a.article_id, magasin_id: a.magasin_id, emplacement_id: a.emplacement_id, lot_id: a.lot_id };
      const kb: BalanceKey = { article_id: b.article_id, magasin_id: b.magasin_id, emplacement_id: b.emplacement_id, lot_id: b.lot_id };
      const kcmp = balanceKeySort(ka, kb);
      if (kcmp !== 0) return kcmp;
      if (a.movement_line_id !== b.movement_line_id) return a.movement_line_id - b.movement_line_id;
      return a.leg_no - b.leg_no;
    });

    for (const leg of legsOrdered) {
      const key = `${leg.article_id}|${leg.magasin_id}|${leg.emplacement_id}|${leg.lot_id ?? ""}`;
      const balance = lockedBalances.get(key);
      if (!balance) throw new Error("Missing locked balance row");

      const before = Number(balance.qty_on_hand);
      const after = before + Number(leg.delta_qty);
      if (!Number.isFinite(after)) throw new Error("Invalid stock computation");
      if (after < 0) {
        throw new HttpError(409, "NEGATIVE_STOCK", "Posting would result in negative stock");
      }

      await client.query(
        `
          UPDATE public.stock_balances
          SET qty_on_hand = $2, updated_at = now(), updated_by = $3
          WHERE id = $1
        `,
        [balance.id, after, audit.user_id]
      );

      await client.query(
        `
          INSERT INTO public.stock_ledger (
            movement_id, movement_line_id, leg_no,
            article_id, magasin_id, emplacement_id, lot_id,
            delta_qty, qty_before, qty_after,
            effective_at, posted_at,
            created_by, updated_by
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
        `,
        [
          id,
          leg.movement_line_id,
          leg.leg_no,
          leg.article_id,
          leg.magasin_id,
          leg.emplacement_id,
          leg.lot_id,
          leg.delta_qty,
          before,
          after,
          effectiveAt.toISOString(),
          postedAt.toISOString(),
          audit.user_id,
        ]
      );

      balance.qty_on_hand = after;
    }

    await client.query(
      `
        UPDATE public.stock_movements
        SET status = 'POSTED', posted_at = now(), posted_by = $2, updated_at = now(), updated_by = $2
        WHERE id = $1
      `,
      [id, audit.user_id]
    );

    await client.query(
      `
        INSERT INTO public.stock_movement_event_log (
          stock_movement_id, event_type, old_values, new_values, user_id, created_by, updated_by
        )
        VALUES ($1,'POSTED',$2::jsonb,$3::jsonb,$4,$4,$4)
      `,
      [
        id,
        JSON.stringify({ status: "DRAFT" }),
        JSON.stringify({ status: "POSTED", posted_at: postedAt.toISOString(), legs_count: legs.length }),
        audit.user_id,
      ]
    );

    await insertAuditLog(client, audit, {
      action: "stock.movements.post",
      entity_type: "stock_movements",
      entity_id: String(id),
      details: {
        movement_no: movement.movement_no,
        movement_type: movement.movement_type,
        legs_count: legs.length,
      },
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

export async function repoListArticleDocuments(articleId: number): Promise<StockDocument[] | null> {
  const exists = await db.query<{ ok: number }>(`SELECT 1::int AS ok FROM public.articles WHERE id = $1`, [articleId]);
  if (!exists.rows[0]?.ok) return null;

  const res = await db.query<StockDocument>(
    `
      SELECT
        sd.id::text AS document_id,
        sd.original_name AS document_name,
        ad.type
      FROM public.article_documents ad
      JOIN public.stock_documents sd ON sd.id = ad.document_id
      WHERE ad.article_id = $1
        AND sd.removed_at IS NULL
      ORDER BY ad.created_at DESC, ad.id DESC
    `,
    [articleId]
  );
  return res.rows;
}

export async function repoAttachArticleDocuments(
  articleId: number,
  documents: UploadedDocument[],
  audit: AuditContext
): Promise<StockDocument[] | null> {
  const client = await db.connect();
  const docsDirRel = path.posix.join("uploads", "docs", "stock", "articles");
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ ok: number }>(`SELECT 1::int AS ok FROM public.articles WHERE id = $1 FOR UPDATE`, [articleId]);
    if (!exists.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const inserted = await insertStockDocuments(client, documents, audit, docsDirRel);
    for (const d of inserted) {
      await client.query(
        `
          INSERT INTO public.article_documents (article_id, document_id, type, version, uploaded_by, created_by, updated_by)
          VALUES ($1,$2::uuid,$3,$4,$5,$5,$5)
          ON CONFLICT DO NOTHING
        `,
        [articleId, d.id, null, 1, audit.user_id]
      );
    }

    await insertAuditLog(client, audit, {
      action: "stock.articles.documents.attach",
      entity_type: "articles",
      entity_id: String(articleId),
      details: {
        count: inserted.length,
        documents: inserted.map((d) => ({ id: d.id, original_name: d.original_name, mime_type: d.mime_type, size_bytes: d.size_bytes })),
      },
    });

    await client.query("COMMIT");
    const out = await repoListArticleDocuments(articleId);
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoRemoveArticleDocument(articleId: number, documentId: string, audit: AuditContext): Promise<boolean | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ ok: number }>(`SELECT 1::int AS ok FROM public.articles WHERE id = $1 FOR UPDATE`, [articleId]);
    if (!exists.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const del = await client.query(
      `DELETE FROM public.article_documents WHERE article_id = $1 AND document_id = $2::uuid`,
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
  articleId: number,
  documentId: string,
  audit: AuditContext
): Promise<StockDocumentRow | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ ok: number }>(`SELECT 1::int AS ok FROM public.articles WHERE id = $1 FOR UPDATE`, [articleId]);
    if (!exists.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const res = await client.query<StockDocumentRow>(
      `
        SELECT
          sd.id::text AS id,
          sd.original_name,
          sd.stored_name,
          sd.storage_path,
          sd.mime_type,
          sd.size_bytes::text AS size_bytes,
          sd.sha256,
          sd.label,
          sd.created_at::text AS created_at,
          sd.updated_at::text AS updated_at,
          sd.uploaded_by,
          sd.removed_at::text AS removed_at,
          sd.removed_by
        FROM public.article_documents ad
        JOIN public.stock_documents sd ON sd.id = ad.document_id
        WHERE ad.article_id = $1
          AND ad.document_id = $2::uuid
          AND sd.removed_at IS NULL
        FOR UPDATE
      `,
      [articleId, documentId]
    );
    const row = res.rows[0] ?? null;
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    await insertAuditLog(client, audit, {
      action: "stock.articles.documents.download",
      entity_type: "stock_documents",
      entity_id: documentId,
      details: { article_id: articleId, original_name: row.original_name },
    });

    await client.query("COMMIT");
    return row;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoListMovementDocuments(movementId: number): Promise<StockDocument[] | null> {
  const exists = await db.query<{ ok: number }>(`SELECT 1::int AS ok FROM public.stock_movements WHERE id = $1`, [movementId]);
  if (!exists.rows[0]?.ok) return null;

  const res = await db.query<StockDocument>(
    `
      SELECT
        sd.id::text AS document_id,
        sd.original_name AS document_name,
        md.type
      FROM public.stock_movement_documents md
      JOIN public.stock_documents sd ON sd.id = md.document_id
      WHERE md.stock_movement_id = $1
        AND sd.removed_at IS NULL
      ORDER BY md.created_at DESC, md.id DESC
    `,
    [movementId]
  );
  return res.rows;
}

export async function repoAttachMovementDocuments(
  movementId: number,
  documents: UploadedDocument[],
  audit: AuditContext
): Promise<StockDocument[] | null> {
  const client = await db.connect();
  const docsDirRel = path.posix.join("uploads", "docs", "stock", "movements");
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.stock_movements WHERE id = $1 FOR UPDATE`,
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
          INSERT INTO public.stock_movement_documents (
            stock_movement_id, document_id, type, version, uploaded_by, created_by, updated_by
          )
          VALUES ($1,$2::uuid,$3,$4,$5,$5,$5)
          ON CONFLICT DO NOTHING
        `,
        [movementId, d.id, null, 1, audit.user_id]
      );
    }

    await insertAuditLog(client, audit, {
      action: "stock.movements.documents.attach",
      entity_type: "stock_movements",
      entity_id: String(movementId),
      details: {
        count: inserted.length,
        documents: inserted.map((d) => ({ id: d.id, original_name: d.original_name, mime_type: d.mime_type, size_bytes: d.size_bytes })),
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
  movementId: number,
  documentId: string,
  audit: AuditContext
): Promise<boolean | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.stock_movements WHERE id = $1 FOR UPDATE`,
      [movementId]
    );
    if (!exists.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const del = await client.query(
      `DELETE FROM public.stock_movement_documents WHERE stock_movement_id = $1 AND document_id = $2::uuid`,
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
  movementId: number,
  documentId: string,
  audit: AuditContext
): Promise<StockDocumentRow | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.stock_movements WHERE id = $1 FOR UPDATE`,
      [movementId]
    );
    if (!exists.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const res = await client.query<StockDocumentRow>(
      `
        SELECT
          sd.id::text AS id,
          sd.original_name,
          sd.stored_name,
          sd.storage_path,
          sd.mime_type,
          sd.size_bytes::text AS size_bytes,
          sd.sha256,
          sd.label,
          sd.created_at::text AS created_at,
          sd.updated_at::text AS updated_at,
          sd.uploaded_by,
          sd.removed_at::text AS removed_at,
          sd.removed_by
        FROM public.stock_movement_documents md
        JOIN public.stock_documents sd ON sd.id = md.document_id
        WHERE md.stock_movement_id = $1
          AND md.document_id = $2::uuid
          AND sd.removed_at IS NULL
        FOR UPDATE
      `,
      [movementId, documentId]
    );
    const row = res.rows[0] ?? null;
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    await insertAuditLog(client, audit, {
      action: "stock.movements.documents.download",
      entity_type: "stock_documents",
      entity_id: documentId,
      details: { stock_movement_id: movementId, original_name: row.original_name },
    });

    await client.query("COMMIT");
    return row;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export function stockDocumentsBaseDir(): string {
  return path.resolve(path.posix.join("uploads", "docs", "stock"));
}
