import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";

import type {
  ProductionGroup,
  ProductionGroupDetail,
  ProductionGroupListItem,
  AffaireLite,
  OfLite,
} from "../types/production-groups.types";
import type {
  CreateProductionGroupBodyDTO,
  LinkProductionGroupBodyDTO,
  ListProductionGroupsQueryDTO,
  UnlinkProductionGroupBodyDTO,
  UpdateProductionGroupBodyDTO,
} from "../validators/production-groups.validators";
import type { AuditContext } from "./production.repository";
import type { Paginated } from "../types/production.types";

type DbQueryer = Pick<import("pg").PoolClient, "query">;

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

async function insertAuditLog(tx: DbQueryer, audit: AuditContext, entry: {
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details?: Record<string, unknown> | null;
}) {
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

function sortDir(dir: "asc" | "desc"): "ASC" | "DESC" {
  return dir === "asc" ? "ASC" : "DESC";
}

function sortColumn(sortBy: ListProductionGroupsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "code":
      return "g.code";
    case "updated_at":
    default:
      return "g.updated_at";
  }
}

function sanitizeCodePart(value: string): string {
  const s = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/-+/g, "-");
  return s.slice(0, 20);
}

async function resolveClientAndPieceParts(tx: DbQueryer, params: {
  client_id: string | null;
  piece_technique_id: string | null;
  piece_code: string | null;
  piece_label: string | null;
}) {
  let clientPart: string | null = null;
  if (params.client_id) {
    // clients.client_id is the stable business identifier in this codebase.
    clientPart = sanitizeCodePart(params.client_id);
  }

  let pieceCode = params.piece_code;
  let pieceLabel = params.piece_label;
  if (params.piece_technique_id) {
    const ptRes = await tx.query<{ code_piece: string | null; designation: string | null }>(
      `SELECT code_piece, designation FROM pieces_techniques WHERE id = $1::uuid LIMIT 1`,
      [params.piece_technique_id]
    );
    const pt = ptRes.rows[0] ?? null;
    pieceCode = pieceCode ?? pt?.code_piece ?? null;
    pieceLabel = pieceLabel ?? pt?.designation ?? null;
  }

  const piecePart = sanitizeCodePart(pieceCode ?? "PIECE");
  return {
    clientPart: clientPart ?? "GEN",
    pieceCode,
    pieceLabel,
    piecePart,
  };
}

async function generateGroupCode(tx: DbQueryer, parts: { clientPart: string; piecePart: string }): Promise<string> {
  const seqRes = await tx.query<{ n: number }>(`SELECT nextval('public.production_group_code_seq')::int AS n`);
  const n = seqRes.rows[0]?.n;
  if (!n) throw new Error("Failed to allocate production group sequence");
  const year = new Date().getFullYear();
  return String(`GRP-${parts.clientPart}-${parts.piecePart}-${year}-${n}`).slice(0, 120);
}

export async function repoListProductionGroups(filters: ListProductionGroupsQueryDTO): Promise<Paginated<ProductionGroupListItem>> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const p = push(`%${filters.q.trim()}%`);
    where.push(`(g.code ILIKE ${p} OR COALESCE(g.piece_code,'') ILIKE ${p} OR COALESCE(g.piece_label,'') ILIKE ${p})`);
  }
  if (filters.client_id && filters.client_id.trim().length > 0) {
    where.push(`g.client_id = ${push(filters.client_id.trim())}`);
  }
  if (filters.piece_technique_id) {
    where.push(`g.piece_technique_id = ${push(filters.piece_technique_id)}::uuid`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const countRes = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM production_group g ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const orderBy = sortColumn(filters.sortBy);
  const orderDir = sortDir(filters.sortDir);

  type Row = {
    id: string;
    code: string;
    client_id: string | null;
    piece_technique_id: string | null;
    piece_code: string | null;
    piece_label: string | null;
    description: string | null;
    updated_at: string;
    linked_affaires_count: number;
    linked_ofs_count: number;
  };

  const dataRes = await pool.query<Row>(
    `
    SELECT
      g.id::text AS id,
      g.code,
      g.client_id,
      g.piece_technique_id::text AS piece_technique_id,
      g.piece_code,
      g.piece_label,
      g.description,
      g.updated_at::text AS updated_at,
      COALESCE(a.cnt, 0)::int AS linked_affaires_count,
      COALESCE(o.cnt, 0)::int AS linked_ofs_count
    FROM production_group g
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS cnt FROM affaire a WHERE a.production_group_id = g.id
    ) a ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS cnt FROM ordres_fabrication o WHERE o.production_group_id = g.id
    ) o ON TRUE
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}, g.id ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
    `,
    [...values, pageSize, offset]
  );

  const items: ProductionGroupListItem[] = dataRes.rows.map((r) => ({
    id: r.id,
    code: r.code,
    client_id: r.client_id,
    piece_technique_id: r.piece_technique_id,
    piece_code: r.piece_code,
    piece_label: r.piece_label,
    description: r.description,
    updated_at: r.updated_at,
    linked_affaires_count: Number(r.linked_affaires_count),
    linked_ofs_count: Number(r.linked_ofs_count),
  }));

  return { items, total };
}

async function mapGroup(row: {
  id: string;
  code: string;
  client_id: string | null;
  piece_technique_id: string | null;
  piece_code: string | null;
  piece_label: string | null;
  description: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: number | null;
  updated_by: number | null;
}): Promise<ProductionGroup> {
  return {
    id: row.id,
    code: row.code,
    client_id: row.client_id,
    piece_technique_id: row.piece_technique_id,
    piece_code: row.piece_code,
    piece_label: row.piece_label,
    description: row.description,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

export async function repoGetProductionGroup(id: string): Promise<ProductionGroupDetail | null> {
  type GroupRow = {
    id: string;
    code: string;
    client_id: string | null;
    piece_technique_id: string | null;
    piece_code: string | null;
    piece_label: string | null;
    description: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
    created_by: number | null;
    updated_by: number | null;
  };

  const groupRes = await pool.query<GroupRow>(
    `
    SELECT
      g.id::text AS id,
      g.code,
      g.client_id,
      g.piece_technique_id::text AS piece_technique_id,
      g.piece_code,
      g.piece_label,
      g.description,
      g.notes,
      g.created_at::text AS created_at,
      g.updated_at::text AS updated_at,
      g.created_by,
      g.updated_by
    FROM production_group g
    WHERE g.id = $1::uuid
    LIMIT 1
    `,
    [id]
  );
  const groupRow = groupRes.rows[0] ?? null;
  if (!groupRow) return null;
  const group = await mapGroup(groupRow);

  type AffaireRow = {
    id: string;
    reference: string;
    client_id: string;
    commande_id: string | null;
    devis_id: string | null;
    statut: string;
    type_affaire: string;
    updated_at: string;
  };
  const affRes = await pool.query<AffaireRow>(
    `
    SELECT
      a.id::text AS id,
      a.reference,
      a.client_id,
      a.commande_id::text AS commande_id,
      a.devis_id::text AS devis_id,
      a.statut,
      a.type_affaire,
      a.updated_at::text AS updated_at
    FROM affaire a
    WHERE a.production_group_id = $1::uuid
    ORDER BY a.updated_at DESC, a.id DESC
    `,
    [id]
  );
  const affaires: AffaireLite[] = affRes.rows.map((r) => ({
    id: toInt(r.id, "affaire.id"),
    reference: r.reference,
    client_id: r.client_id,
    commande_id: r.commande_id ? toInt(r.commande_id, "affaire.commande_id") : null,
    devis_id: r.devis_id ? toInt(r.devis_id, "affaire.devis_id") : null,
    statut: r.statut,
    type_affaire: r.type_affaire,
    updated_at: r.updated_at,
  }));

  type OfRow = {
    id: string;
    numero: string;
    affaire_id: string | null;
    commande_id: string | null;
    client_id: string | null;
    piece_technique_id: string;
    piece_code: string;
    piece_designation: string;
    statut: string;
    priority: string;
    updated_at: string;
  };
  const ofRes = await pool.query<OfRow>(
    `
    SELECT
      o.id::text AS id,
      o.numero,
      o.affaire_id::text AS affaire_id,
      o.commande_id::text AS commande_id,
      o.client_id,
      o.piece_technique_id::text AS piece_technique_id,
      pt.code_piece AS piece_code,
      pt.designation AS piece_designation,
      o.statut::text AS statut,
      o.priority::text AS priority,
      o.updated_at::text AS updated_at
    FROM ordres_fabrication o
    JOIN pieces_techniques pt ON pt.id = o.piece_technique_id
    WHERE o.production_group_id = $1::uuid
    ORDER BY o.updated_at DESC, o.id DESC
    `,
    [id]
  );
  const ofs: OfLite[] = ofRes.rows.map((r) => ({
    id: toInt(r.id, "ordres_fabrication.id"),
    numero: r.numero,
    affaire_id: r.affaire_id ? toInt(r.affaire_id, "ordres_fabrication.affaire_id") : null,
    commande_id: r.commande_id ? toInt(r.commande_id, "ordres_fabrication.commande_id") : null,
    client_id: r.client_id,
    piece_technique_id: r.piece_technique_id,
    piece_code: r.piece_code,
    piece_designation: r.piece_designation,
    statut: r.statut,
    priority: r.priority,
    updated_at: r.updated_at,
  }));

  return { group, affaires, ofs };
}

export async function repoCreateProductionGroup(params: {
  body: CreateProductionGroupBodyDTO;
  audit: AuditContext;
}): Promise<{ id: string }>
{
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const b = params.body;
    const parts = await resolveClientAndPieceParts(client, {
      client_id: b.client_id ?? null,
      piece_technique_id: b.piece_technique_id ?? null,
      piece_code: b.piece_code ?? null,
      piece_label: b.piece_label ?? null,
    });

    const code = typeof b.code === "string" && b.code.trim().length > 0 ? b.code.trim() : await generateGroupCode(client, parts);

    const ins = await client.query<{ id: string }>(
      `
      INSERT INTO production_group (
        code,
        client_id,
        piece_technique_id,
        piece_code,
        piece_label,
        description,
        notes,
        created_by,
        updated_by
      ) VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9)
      RETURNING id::text AS id
      `,
      [
        code,
        b.client_id ?? null,
        b.piece_technique_id ?? null,
        parts.pieceCode ?? null,
        parts.pieceLabel ?? null,
        b.description ?? null,
        b.notes ?? null,
        params.audit.user_id,
        params.audit.user_id,
      ]
    );
    const id = ins.rows[0]?.id;
    if (!id) throw new Error("Failed to create production group");

    await insertAuditLog(client, params.audit, {
      action: "production.groups.create",
      entity_type: "production_group",
      entity_id: id,
      details: { code },
    });

    await client.query("COMMIT");
    return { id };
  } catch (err) {
    await client.query("ROLLBACK");
    // Unique violation maps to 409.
    if ((err as { code?: unknown } | null)?.code === "23505") {
      throw new HttpError(409, "PRODUCTION_GROUP_CODE_EXISTS", "A production group with this code already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateProductionGroup(params: {
  id: string;
  patch: UpdateProductionGroupBodyDTO;
  audit: AuditContext;
}): Promise<{ id: string } | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM production_group WHERE id = $1::uuid FOR UPDATE`,
      [params.id]
    );
    if (!before.rows[0]?.id) {
      await client.query("ROLLBACK");
      return null;
    }

    const p = params.patch;
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    if (p.client_id !== undefined) sets.push(`client_id = ${push(p.client_id ?? null)}`);
    if (p.piece_technique_id !== undefined) sets.push(`piece_technique_id = ${push(p.piece_technique_id ?? null)}::uuid`);
    if (p.piece_code !== undefined) sets.push(`piece_code = ${push(p.piece_code ?? null)}`);
    if (p.piece_label !== undefined) sets.push(`piece_label = ${push(p.piece_label ?? null)}`);
    if (p.description !== undefined) sets.push(`description = ${push(p.description ?? null)}`);
    if (p.notes !== undefined) sets.push(`notes = ${push(p.notes ?? null)}`);
    sets.push(`updated_by = ${push(params.audit.user_id)}`);
    sets.push(`updated_at = now()`);

    if (sets.length) {
      await client.query(
        `UPDATE production_group SET ${sets.join(", ")} WHERE id = ${push(params.id)}::uuid`,
        values
      );
    }

    await insertAuditLog(client, params.audit, {
      action: "production.groups.update",
      entity_type: "production_group",
      entity_id: params.id,
      details: { patch: params.patch },
    });

    await client.query("COMMIT");
    return { id: params.id };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function assertGroupExistsForUpdate(client: DbQueryer, id: string) {
  const res = await client.query(`SELECT id FROM production_group WHERE id = $1::uuid LIMIT 1`, [id]);
  if ((res.rowCount ?? 0) === 0) throw new HttpError(404, "PRODUCTION_GROUP_NOT_FOUND", "Production group not found");
}

async function assertAllAffairesExist(tx: DbQueryer, ids: number[]) {
  if (!ids.length) return;
  const res = await tx.query<{ id: number }>(`SELECT id FROM affaire WHERE id = ANY($1::bigint[])`, [ids]);
  const found = new Set(res.rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw new HttpError(404, "AFFAIRE_NOT_FOUND", `Affaire not found: ${missing.slice(0, 5).join(",")}`);
  }
}

async function assertAllOfsExist(tx: DbQueryer, ids: number[]) {
  if (!ids.length) return;
  const res = await tx.query<{ id: number }>(`SELECT id FROM ordres_fabrication WHERE id = ANY($1::bigint[])`, [ids]);
  const found = new Set(res.rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw new HttpError(404, "OF_NOT_FOUND", `OF not found: ${missing.slice(0, 5).join(",")}`);
  }
}

export async function repoLinkProductionGroup(params: {
  id: string;
  body: LinkProductionGroupBodyDTO;
  audit: AuditContext;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM production_group WHERE id = $1::uuid FOR UPDATE`, [params.id]);
    await assertGroupExistsForUpdate(client, params.id);

    const affaireIds = params.body.affaire_ids ?? [];
    const ofIds = params.body.of_ids ?? [];

    await assertAllAffairesExist(client, affaireIds);
    await assertAllOfsExist(client, ofIds);

    if (affaireIds.length) {
      await client.query(
        `UPDATE affaire SET production_group_id = $2::uuid, updated_at = now() WHERE id = ANY($1::bigint[])`,
        [affaireIds, params.id]
      );
    }
    if (ofIds.length) {
      await client.query(
        `UPDATE ordres_fabrication SET production_group_id = $2::uuid, updated_at = now(), updated_by = $3 WHERE id = ANY($1::bigint[])`,
        [ofIds, params.id, params.audit.user_id]
      );
    }

    await client.query(`UPDATE production_group SET updated_by = $2 WHERE id = $1::uuid`, [params.id, params.audit.user_id]);

    await insertAuditLog(client, params.audit, {
      action: "production.groups.link",
      entity_type: "production_group",
      entity_id: params.id,
      details: { affaire_ids: affaireIds, of_ids: ofIds },
    });

    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUnlinkProductionGroup(params: {
  id: string;
  body: UnlinkProductionGroupBodyDTO;
  audit: AuditContext;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM production_group WHERE id = $1::uuid FOR UPDATE`, [params.id]);
    await assertGroupExistsForUpdate(client, params.id);

    const affaireIds = params.body.affaire_ids ?? [];
    const ofIds = params.body.of_ids ?? [];

    await assertAllAffairesExist(client, affaireIds);
    await assertAllOfsExist(client, ofIds);

    if (affaireIds.length) {
      await client.query(
        `UPDATE affaire SET production_group_id = NULL, updated_at = now() WHERE id = ANY($1::bigint[]) AND production_group_id = $2::uuid`,
        [affaireIds, params.id]
      );
    }
    if (ofIds.length) {
      await client.query(
        `UPDATE ordres_fabrication SET production_group_id = NULL, updated_at = now(), updated_by = $3 WHERE id = ANY($1::bigint[]) AND production_group_id = $2::uuid`,
        [ofIds, params.id, params.audit.user_id]
      );
    }

    await client.query(`UPDATE production_group SET updated_by = $2 WHERE id = $1::uuid`, [params.id, params.audit.user_id]);

    await insertAuditLog(client, params.audit, {
      action: "production.groups.unlink",
      entity_type: "production_group",
      entity_id: params.id,
      details: { affaire_ids: affaireIds, of_ids: ofIds },
    });

    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
