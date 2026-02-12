import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { computeDocumentTotals, computeLineTotals } from "../lib/totals";
import type { ClientLite, DocumentClient } from "../types/shared.types";
import type { AvoirDetail, AvoirDocument, AvoirHeader, AvoirLine, AvoirListItem, Paginated } from "../types/avoirs.types";
import type { CreateAvoirBodyDTO, ListAvoirsQueryDTO, UpdateAvoirBodyDTO } from "../validators/avoirs.validators";

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function toNullableInt(value: unknown, label = "id"): number | null {
  if (value === null || value === undefined) return null;
  return toInt(value, label);
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

function sortColumn(sortBy: ListAvoirsQueryDTO["sortBy"]) {
  switch (sortBy) {
    case "numero":
      return "a.numero";
    case "date_emission":
      return "a.date_emission";
    case "total_ttc":
      return "a.total_ttc";
    case "updated_at":
      return "a.updated_at";
    default:
      return "a.date_emission";
  }
}

function sortDirection(sortDir: ListAvoirsQueryDTO["sortDir"]) {
  return sortDir === "asc" ? "ASC" : "DESC";
}

type ListWhere = { whereSql: string; values: unknown[] };
function buildListWhere(filters: ListAvoirsQueryDTO, includeClientInSearch: boolean): ListWhere {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const p = push(`%${filters.q.trim()}%`);
    if (includeClientInSearch) {
      where.push(`(a.numero ILIKE ${p} OR c.company_name ILIKE ${p})`);
    } else {
      where.push(`a.numero ILIKE ${p}`);
    }
  }

  if (filters.client_id && filters.client_id.trim().length > 0) {
    const p = push(filters.client_id.trim());
    where.push(`a.client_id = ${p}`);
  }

  if (typeof filters.facture_id === "number" && Number.isFinite(filters.facture_id)) {
    const p = push(filters.facture_id);
    where.push(`a.facture_id = ${p}::bigint`);
  }

  if (filters.statut && filters.statut.trim().length > 0) {
    const p = push(filters.statut.trim());
    where.push(`a.statut = ${p}`);
  }

  if (filters.from) {
    const p = push(filters.from);
    where.push(`a.date_emission >= ${p}::date`);
  }

  if (filters.to) {
    const p = push(filters.to);
    where.push(`a.date_emission <= ${p}::date`);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    values,
  };
}

export async function repoListAvoirs(filters: ListAvoirsQueryDTO): Promise<Paginated<AvoirListItem>> {
  const includes = includesSet(filters.include ?? "client");
  const includeClient = includes.has("client");
  const includeFacture = includes.has("facture");
  const joinClient = includeClient || (filters.q ? filters.q.trim().length > 0 : false);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const joinClientSql = joinClient ? "LEFT JOIN clients c ON c.client_id = a.client_id" : "";
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

  const joinFactureSql = includeFacture ? "LEFT JOIN facture f ON f.id = a.facture_id" : "";
  const factureSelectSql = includeFacture
    ? `CASE WHEN f.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', f.id,
        'numero', f.numero
      ) END AS facture`
    : "NULL AS facture";

  const { whereSql, values } = buildListWhere(filters, joinClient);
  const orderBy = sortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM avoir a
    ${joinClientSql}
    ${whereSql}
  `;
  const countRes = await pool.query<{ total: number }>(countSql, values);
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      a.id::text AS id,
      a.numero,
      a.client_id,
      a.facture_id::text AS facture_id,
      a.date_emission::text AS date_emission,
      a.total_ht::float8 AS total_ht,
      a.total_ttc::float8 AS total_ttc,
      a.updated_at::text AS updated_at,
      a.statut,
      ${clientSelectSql},
      ${factureSelectSql}
    FROM avoir a
    ${joinClientSql}
    ${joinFactureSql}
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;
  const dataValues = [...values, pageSize, offset];
  type Row = Omit<AvoirListItem, "id" | "facture_id" | "client" | "facture"> & {
    id: string;
    facture_id: string | null;
    client: ClientLite | null;
    facture: { id: number; numero: string } | null;
  };

  const dataRes = await pool.query<Row>(dataSql, dataValues);
  const items: AvoirListItem[] = dataRes.rows.map((r) => ({
    ...r,
    id: toInt(r.id, "avoir.id"),
    facture_id: toNullableInt(r.facture_id, "avoir.facture_id"),
    client: includeClient ? r.client : undefined,
    facture: includeFacture ? r.facture : undefined,
  }));

  return { items, total };
}

type IncludeFlags = {
  lignes: boolean;
  documents: boolean;
  client: boolean;
  facture: boolean;
};

function includeFlags(includes: Set<string>): IncludeFlags {
  const has = (v: string) => includes.has(v);
  return {
    lignes: has("lignes"),
    documents: has("documents"),
    client: has("client"),
    facture: has("facture"),
  };
}

export async function repoGetAvoir(id: number, includeValue: string): Promise<AvoirDetail | null> {
  const includes = includesSet(includeValue);
  const inc = includeFlags(includes);

  const joinClientSql = inc.client ? "LEFT JOIN clients c ON c.client_id = a.client_id" : "";
  const clientSelectSql = inc.client
    ? `CASE WHEN c.client_id IS NULL THEN NULL ELSE jsonb_build_object(
        'client_id', c.client_id,
        'company_name', c.company_name,
        'email', c.email,
        'phone', c.phone,
        'delivery_address_id', c.delivery_address_id::text,
        'bill_address_id', c.bill_address_id::text
      ) END AS client`
    : "NULL AS client";

  const joinFactureSql = inc.facture ? "LEFT JOIN facture f ON f.id = a.facture_id" : "";
  const factureSelectSql = inc.facture
    ? `CASE WHEN f.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', f.id,
        'numero', f.numero
      ) END AS facture`
    : "NULL AS facture";

  const headerSql = `
    SELECT
      a.id::text AS id,
      a.numero,
      a.client_id,
      a.facture_id::text AS facture_id,
      a.date_emission::text AS date_emission,
      a.statut,
      a.motif,
      a.total_ht::float8 AS total_ht,
      a.total_ttc::float8 AS total_ttc,
      a.created_at::text AS created_at,
      a.updated_at::text AS updated_at,
      ${clientSelectSql},
      ${factureSelectSql}
    FROM avoir a
    ${joinClientSql}
    ${joinFactureSql}
    WHERE a.id = $1
  `;

  type HeaderRow = Omit<AvoirHeader, "id" | "facture_id" | "client" | "facture"> & {
    id: string;
    facture_id: string | null;
    client: ClientLite | null;
    facture: { id: number; numero: string } | null;
  };

  const headerRes = await pool.query<HeaderRow>(headerSql, [id]);
  const row = headerRes.rows[0] ?? null;
  if (!row) return null;

  const avoir: AvoirHeader = {
    ...row,
    id: toInt(row.id, "avoir.id"),
    facture_id: toNullableInt(row.facture_id, "avoir.facture_id"),
    client: inc.client ? row.client : undefined,
    facture: inc.facture ? row.facture : undefined,
  };

  const lignes: AvoirLine[] = inc.lignes
    ? (
        await pool.query<
          Omit<AvoirLine, "id" | "avoir_id"> & { id: string; avoir_id: string }
        >(
          `
          SELECT
            id::text AS id,
            avoir_id::text AS avoir_id,
            ordre,
            designation,
            code_piece,
            quantite::float8 AS quantite,
            unite,
            prix_unitaire_ht::float8 AS prix_unitaire_ht,
            remise_ligne::float8 AS remise_ligne,
            taux_tva::float8 AS taux_tva,
            total_ht::float8 AS total_ht,
            total_ttc::float8 AS total_ttc
          FROM avoir_ligne
          WHERE avoir_id = $1
          ORDER BY ordre ASC, id ASC
          `,
          [id]
        )
      ).rows.map((l) => ({
        ...l,
        id: toInt(l.id, "avoir_ligne.id"),
        avoir_id: toInt(l.avoir_id, "avoir_ligne.avoir_id"),
      }))
    : [];

  const documents: AvoirDocument[] = inc.documents
    ? (
        await pool.query<
          Omit<AvoirDocument, "id" | "avoir_id" | "document"> & {
            id: string;
            avoir_id: string;
            document: DocumentClient | null;
          }
        >(
          `
          SELECT
            ad.id::text AS id,
            ad.avoir_id::text AS avoir_id,
            ad.document_id::text AS document_id,
            ad.type,
            ad.created_at::text AS created_at,
            CASE WHEN dc.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', dc.id::text,
              'document_name', dc.document_name,
              'type', dc.type,
              'creation_date', dc.creation_date::text,
              'created_by', dc.created_by
            ) END AS document
          FROM avoir_documents ad
          LEFT JOIN documents_clients dc ON dc.id = ad.document_id
          WHERE ad.avoir_id = $1
          ORDER BY ad.id DESC
          `,
          [id]
        )
      ).rows.map((d) => ({
        ...d,
        id: toInt(d.id, "avoir_documents.id"),
        avoir_id: toInt(d.avoir_id, "avoir_documents.avoir_id"),
      }))
    : [];

  return { avoir, lignes, documents };
}

async function insertAvoirLines(client: PoolClient, avoirId: number, lignes: CreateAvoirBodyDTO["lignes"]) {
  if (!lignes.length) return;

  const params: unknown[] = [avoirId];
  const valuesSql: string[] = [];

  for (let idx = 0; idx < lignes.length; idx += 1) {
    const l = lignes[idx];
    const totals = computeLineTotals(l);
    const ordre = idx + 1;

    const baseIndex = params.length;
    params.push(
      ordre,
      l.designation,
      l.code_piece ?? null,
      l.quantite,
      l.unite ?? null,
      l.prix_unitaire_ht,
      l.remise_ligne ?? 0,
      l.taux_tva ?? 20,
      totals.total_ht,
      totals.total_ttc
    );

    const placeholders = Array.from({ length: 10 }, (_, j) => `$${baseIndex + 1 + j}`).join(",");
    valuesSql.push(`($1,${placeholders})`);
  }

  await client.query(
    `
    INSERT INTO avoir_ligne (
      avoir_id,
      ordre,
      designation,
      code_piece,
      quantite,
      unite,
      prix_unitaire_ht,
      remise_ligne,
      taux_tva,
      total_ht,
      total_ttc
    ) VALUES ${valuesSql.join(",")}
    `,
    params
  );
}

export async function repoCreateAvoir(input: CreateAvoirBodyDTO) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const seq = await client.query<{ id: string }>(`SELECT nextval('public.avoir_id_seq')::bigint::text AS id`);
    const idRaw = seq.rows[0]?.id;
    if (!idRaw) throw new Error("Failed to allocate avoir id");
    const avoirId = toInt(idRaw, "avoir.id");

    const numero = (input.numero ?? `AV-${avoirId}`).slice(0, 30);
    const totals = computeDocumentTotals(input.lignes, 0);

    const ins = await client.query<{ id: string }>(
      `
      INSERT INTO avoir (
        id,
        numero,
        client_id,
        facture_id,
        date_emission,
        statut,
        motif,
        total_ht,
        total_ttc
      ) VALUES (
        $1,$2,$3,
        $4::bigint,
        COALESCE($5::date, CURRENT_DATE),
        $6,$7,
        $8,$9
      )
      RETURNING id::text AS id
      `,
      [
        avoirId,
        numero,
        input.client_id,
        input.facture_id ?? null,
        input.date_emission ?? null,
        input.statut,
        input.motif ?? null,
        totals.total_ht,
        totals.total_ttc,
      ]
    );

    await insertAvoirLines(client, avoirId, input.lignes);

    if (input.facture_id) {
      await client.query(`UPDATE facture SET updated_at = now() WHERE id = $1`, [input.facture_id]);
    }

    await client.query("COMMIT");
    const inserted = ins.rows[0]?.id;
    return { id: inserted ? toInt(inserted, "avoir.id") : avoirId };
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "avoir_numero_key") {
      throw new HttpError(409, "AVOIR_NUMERO_EXISTS", "Numero already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateAvoir(id: number, input: UpdateAvoirBodyDTO) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const baseRes = await client.query<{ id: string; facture_id: string | null }>(
      `
      SELECT id::text AS id, facture_id::text AS facture_id
      FROM avoir
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

    const hasAnyFieldUpdate = Object.keys(input).length > 0;
    const hasLineUpdate = Array.isArray(input.lignes);
    if (!hasAnyFieldUpdate && !hasLineUpdate) {
      await client.query("ROLLBACK");
      throw new HttpError(400, "NO_UPDATE", "No fields to update");
    }

    const lignesSource = hasLineUpdate
      ? (input.lignes as CreateAvoirBodyDTO["lignes"])
      : (
          await client.query<{
            designation: string;
            code_piece: string | null;
            quantite: number;
            unite: string | null;
            prix_unitaire_ht: number;
            remise_ligne: number;
            taux_tva: number;
          }>(
            `
            SELECT
              designation,
              code_piece,
              quantite::float8 AS quantite,
              unite,
              prix_unitaire_ht::float8 AS prix_unitaire_ht,
              remise_ligne::float8 AS remise_ligne,
              taux_tva::float8 AS taux_tva
            FROM avoir_ligne
            WHERE avoir_id = $1
            ORDER BY ordre ASC, id ASC
            `,
            [id]
          )
        ).rows;

    const totals = computeDocumentTotals(lignesSource, 0);

    const sets: string[] = [];
    const values: unknown[] = [id];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    if (input.numero !== undefined) sets.push(`numero = ${push(input.numero)}`);
    if (input.client_id !== undefined) sets.push(`client_id = ${push(input.client_id)}`);
    if (input.facture_id !== undefined) sets.push(`facture_id = ${push(input.facture_id)}::bigint`);
    if (input.date_emission !== undefined) sets.push(`date_emission = ${push(input.date_emission)}::date`);
    if (input.statut !== undefined) sets.push(`statut = ${push(input.statut)}`);
    if (input.motif !== undefined) sets.push(`motif = ${push(input.motif)}`);

    sets.push(`total_ht = ${push(totals.total_ht)}`);
    sets.push(`total_ttc = ${push(totals.total_ttc)}`);
    sets.push(`updated_at = now()`);

    const updateSql = `
      UPDATE avoir
      SET ${sets.join(", ")}
      WHERE id = $1
      RETURNING id::text AS id, facture_id::text AS facture_id
    `;
    const updated = await client.query<{ id: string; facture_id: string | null }>(updateSql, values);
    const updatedRow = updated.rows[0] ?? null;
    if (!updatedRow) {
      await client.query("ROLLBACK");
      return null;
    }

    if (hasLineUpdate) {
      await client.query(`DELETE FROM avoir_ligne WHERE avoir_id = $1`, [id]);
      await insertAvoirLines(client, id, lignesSource);
    }

    const factureId = toNullableInt(updatedRow.facture_id, "avoir.facture_id");
    if (factureId) {
      await client.query(`UPDATE facture SET updated_at = now() WHERE id = $1`, [factureId]);
    }

    await client.query("COMMIT");
    return { id: toInt(updatedRow.id, "avoir.id") };
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "avoir_numero_key") {
      throw new HttpError(409, "AVOIR_NUMERO_EXISTS", "Numero already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoDeleteAvoir(id: number) {
  const res = await pool.query<{ facture_id: string | null }>(
    `DELETE FROM avoir WHERE id = $1 RETURNING facture_id::text AS facture_id`,
    [id]
  );
  const factureId = res.rows[0]?.facture_id ? toNullableInt(res.rows[0].facture_id, "avoir.facture_id") : null;
  if (factureId) {
    await pool.query(`UPDATE facture SET updated_at = now() WHERE id = $1`, [factureId]);
  }
  return (res.rowCount ?? 0) > 0;
}
