import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { ClientLite } from "../types/shared.types";
import type { Paginated, Paiement, PaiementListItem } from "../types/paiements.types";
import type { CreatePaiementBodyDTO, ListPaiementsQueryDTO, UpdatePaiementBodyDTO } from "../validators/paiements.validators";

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getPgErrorInfo(err: unknown) {
  if (!isRecord(err)) return { code: null as string | null, constraint: null as string | null };
  const code = typeof err.code === "string" ? err.code : null;
  const constraint = typeof err.constraint === "string" ? err.constraint : null;
  return { code, constraint };
}

function includesSet(includeValue: string) {
  return new Set(
    includeValue
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
  );
}

function sortColumn(sortBy: ListPaiementsQueryDTO["sortBy"]) {
  switch (sortBy) {
    case "date_paiement":
      return "p.date_paiement";
    case "montant":
      return "p.montant";
    case "updated_at":
      return "p.updated_at";
    default:
      return "p.date_paiement";
  }
}

function sortDirection(sortDir: ListPaiementsQueryDTO["sortDir"]) {
  return sortDir === "asc" ? "ASC" : "DESC";
}

type ListWhere = { whereSql: string; values: unknown[] };
function buildListWhere(filters: ListPaiementsQueryDTO, includeClientInSearch: boolean): ListWhere {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const p = push(`%${filters.q.trim()}%`);
    const chunks = [
      `p.reference ILIKE ${p}`,
      `f.numero ILIKE ${p}`,
    ];
    if (includeClientInSearch) chunks.push(`c.company_name ILIKE ${p}`);
    where.push(`(${chunks.join(" OR ")})`);
  }

  if (filters.client_id && filters.client_id.trim().length > 0) {
    const p = push(filters.client_id.trim());
    where.push(`p.client_id = ${p}`);
  }

  if (typeof filters.facture_id === "number" && Number.isFinite(filters.facture_id)) {
    const p = push(filters.facture_id);
    where.push(`p.facture_id = ${p}::bigint`);
  }

  if (filters.from) {
    const p = push(filters.from);
    where.push(`p.date_paiement >= ${p}::date`);
  }

  if (filters.to) {
    const p = push(filters.to);
    where.push(`p.date_paiement <= ${p}::date`);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    values,
  };
}

export async function repoListPaiements(filters: ListPaiementsQueryDTO): Promise<Paginated<PaiementListItem>> {
  const includes = includesSet(filters.include ?? "client,facture");
  const includeClient = includes.has("client");
  const includeFacture = includes.has("facture");
  const joinClient = includeClient || (filters.q ? filters.q.trim().length > 0 : false);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const joinFactureSql = "JOIN facture f ON f.id = p.facture_id";
  const joinClientSql = joinClient ? "LEFT JOIN clients c ON c.client_id = p.client_id" : "";

  const clientSelectSql = includeClient
    ? `CASE WHEN c.client_id IS NULL THEN NULL ELSE jsonb_build_object(
        'client_id', c.client_id,
        'company_name', c.company_name,
        'email', c.email,
        'phone', c.phone,
        'delivery_address_id', c.delivery_address_id::text,
        'bill_address_id', c.bill_address_id::text
      ) END AS client`
    : "NULL AS client";

  const factureSelectSql = includeFacture
    ? `jsonb_build_object(
        'id', f.id,
        'numero', f.numero,
        'client_id', f.client_id
      ) AS facture`
    : "NULL AS facture";

  const { whereSql, values } = buildListWhere(filters, joinClient);
  const orderBy = sortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM paiement p
    ${joinFactureSql}
    ${joinClientSql}
    ${whereSql}
  `;
  const countRes = await pool.query<{ total: number }>(countSql, values);
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      p.id::text AS id,
      p.facture_id::text AS facture_id,
      p.client_id,
      p.date_paiement::text AS date_paiement,
      p.montant::float8 AS montant,
      p.mode,
      p.reference,
      p.updated_at::text AS updated_at,
      ${clientSelectSql},
      ${factureSelectSql}
    FROM paiement p
    ${joinFactureSql}
    ${joinClientSql}
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;
  const dataValues = [...values, pageSize, offset];

  type Row = Omit<PaiementListItem, "id" | "facture_id" | "client" | "facture"> & {
    id: string;
    facture_id: string;
    client: ClientLite | null;
    facture: { id: number; numero: string; client_id: string } | null;
  };

  const dataRes = await pool.query<Row>(dataSql, dataValues);
  const items: PaiementListItem[] = dataRes.rows.map((r) => ({
    ...r,
    id: toInt(r.id, "paiement.id"),
    facture_id: toInt(r.facture_id, "paiement.facture_id"),
    client: includeClient ? r.client : undefined,
    facture: includeFacture ? r.facture : undefined,
  }));

  return { items, total };
}

export async function repoGetPaiement(id: number, includeValue: string): Promise<Paiement | null> {
  const includes = includesSet(includeValue);
  const includeClient = includes.has("client");
  const includeFacture = includes.has("facture");

  const joinFactureSql = includeFacture ? "JOIN facture f ON f.id = p.facture_id" : "";
  const joinClientSql = includeClient ? "LEFT JOIN clients c ON c.client_id = p.client_id" : "";

  const clientSelectSql = includeClient
    ? `CASE WHEN c.client_id IS NULL THEN NULL ELSE jsonb_build_object(
        'client_id', c.client_id,
        'company_name', c.company_name,
        'email', c.email,
        'phone', c.phone,
        'delivery_address_id', c.delivery_address_id::text,
        'bill_address_id', c.bill_address_id::text
      ) END AS client`
    : "NULL AS client";

  const factureSelectSql = includeFacture
    ? `jsonb_build_object(
        'id', f.id,
        'numero', f.numero,
        'client_id', f.client_id
      ) AS facture`
    : "NULL AS facture";

  const sql = `
    SELECT
      p.id::text AS id,
      p.facture_id::text AS facture_id,
      p.client_id,
      p.date_paiement::text AS date_paiement,
      p.montant::float8 AS montant,
      p.mode,
      p.reference,
      p.commentaire,
      p.created_at::text AS created_at,
      p.updated_at::text AS updated_at,
      ${clientSelectSql},
      ${factureSelectSql}
    FROM paiement p
    ${joinFactureSql}
    ${joinClientSql}
    WHERE p.id = $1
  `;

  type Row = Omit<Paiement, "id" | "facture_id" | "client" | "facture"> & {
    id: string;
    facture_id: string;
    client: ClientLite | null;
    facture: { id: number; numero: string; client_id: string } | null;
  };

  const res = await pool.query<Row>(sql, [id]);
  const row = res.rows[0] ?? null;
  if (!row) return null;

  return {
    ...row,
    id: toInt(row.id, "paiement.id"),
    facture_id: toInt(row.facture_id, "paiement.facture_id"),
    client: includeClient ? row.client : undefined,
    facture: includeFacture ? row.facture : undefined,
  };
}

export async function repoCreatePaiement(input: CreatePaiementBodyDTO) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const invRes = await client.query<{ id: string; client_id: string }>(
      `
      SELECT id::text AS id, client_id
      FROM facture
      WHERE id = $1
      FOR UPDATE
      `,
      [input.facture_id]
    );
    const inv = invRes.rows[0] ?? null;
    if (!inv) {
      await client.query("ROLLBACK");
      throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture not found");
    }

    const effectiveClientId = input.client_id ?? inv.client_id;
    if (input.client_id && input.client_id !== inv.client_id) {
      await client.query("ROLLBACK");
      throw new HttpError(422, "CLIENT_MISMATCH", "client_id must match facture.client_id");
    }

    const seq = await client.query<{ id: string }>(`SELECT nextval('public.paiement_id_seq')::bigint::text AS id`);
    const idRaw = seq.rows[0]?.id;
    if (!idRaw) throw new Error("Failed to allocate paiement id");
    const paiementId = toInt(idRaw, "paiement.id");

    const ins = await client.query<{ id: string }>(
      `
      INSERT INTO paiement (
        id,
        facture_id,
        client_id,
        date_paiement,
        montant,
        mode,
        reference,
        commentaire
      ) VALUES (
        $1,$2,$3,
        COALESCE($4::date, CURRENT_DATE),
        $5,$6,$7,$8
      )
      RETURNING id::text AS id
      `,
      [
        paiementId,
        input.facture_id,
        effectiveClientId,
        input.date_paiement ?? null,
        input.montant,
        input.mode ?? null,
        input.reference ?? null,
        input.commentaire ?? null,
      ]
    );

    await client.query(`UPDATE facture SET updated_at = now() WHERE id = $1`, [input.facture_id]);

    await client.query("COMMIT");
    const inserted = ins.rows[0]?.id;
    return { id: inserted ? toInt(inserted, "paiement.id") : paiementId };
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23503" && constraint === "paiement_facture_id_fkey") {
      throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture not found");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdatePaiement(id: number, input: UpdatePaiementBodyDTO) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const baseRes = await client.query<{ id: string; facture_id: string }>(
      `
      SELECT id::text AS id, facture_id::text AS facture_id
      FROM paiement
      WHERE id = $1
      FOR UPDATE
      `,
      [id]
    );
    const base = baseRes.rows[0] ?? null;
    if (!base) {
      await client.query("ROLLBACK");
      return null;
    }

    const sets: string[] = [];
    const values: unknown[] = [id];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    if (input.facture_id !== undefined) sets.push(`facture_id = ${push(input.facture_id)}::bigint`);
    if (input.client_id !== undefined) sets.push(`client_id = ${push(input.client_id)}`);
    if (input.date_paiement !== undefined) sets.push(`date_paiement = ${push(input.date_paiement)}::date`);
    if (input.montant !== undefined) sets.push(`montant = ${push(input.montant)}`);
    if (input.mode !== undefined) sets.push(`mode = ${push(input.mode)}`);
    if (input.reference !== undefined) sets.push(`reference = ${push(input.reference)}`);
    if (input.commentaire !== undefined) sets.push(`commentaire = ${push(input.commentaire)}`);

    if (sets.length === 0) {
      await client.query("ROLLBACK");
      throw new HttpError(400, "NO_UPDATE", "No fields to update");
    }

    sets.push(`updated_at = now()`);

    const updateSql = `
      UPDATE paiement
      SET ${sets.join(", ")}
      WHERE id = $1
      RETURNING id::text AS id, facture_id::text AS facture_id
    `;
    const updated = await client.query<{ id: string; facture_id: string }>(updateSql, values);
    const row = updated.rows[0] ?? null;
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    const factureId = toInt(row.facture_id, "paiement.facture_id");
    await client.query(`UPDATE facture SET updated_at = now() WHERE id = $1`, [factureId]);

    await client.query("COMMIT");
    return { id: toInt(row.id, "paiement.id") };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoDeletePaiement(id: number) {
  const res = await pool.query<{ facture_id: string }>(
    `DELETE FROM paiement WHERE id = $1 RETURNING facture_id::text AS facture_id`,
    [id]
  );
  const factureId = res.rows[0]?.facture_id ? toInt(res.rows[0].facture_id, "paiement.facture_id") : null;
  if (factureId) {
    await pool.query(`UPDATE facture SET updated_at = now() WHERE id = $1`, [factureId]);
  }
  return (res.rowCount ?? 0) > 0;
}
