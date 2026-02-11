import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { ListAffairesQueryDTO, CreateAffaireBodyDTO, UpdateAffaireBodyDTO } from "../validators/affaire.validators";
import type { Affaire, AffaireListItem, ClientLite, CommandeHeaderLite, DevisHeaderLite } from "../types/affaire.types";

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

function sortColumn(sortBy: ListAffairesQueryDTO["sortBy"]) {
  switch (sortBy) {
    case "reference":
      return "a.reference";
    case "date_ouverture":
      return "a.date_ouverture";
    case "updated_at":
    default:
      return "a.updated_at";
  }
}

function sortDirection(sortDir: ListAffairesQueryDTO["sortDir"]) {
  return sortDir === "asc" ? "ASC" : "DESC";
}

type ListWhere = { whereSql: string; values: unknown[] };
function buildListWhere(filters: ListAffairesQueryDTO, includeClientInSearch: boolean): ListWhere {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const p = push(`%${filters.q.trim()}%`);
    if (includeClientInSearch) {
      where.push(`(a.reference ILIKE ${p} OR c.company_name ILIKE ${p})`);
    } else {
      where.push(`a.reference ILIKE ${p}`);
    }
  }

  if (filters.client_id && filters.client_id.trim().length > 0) {
    const p = push(filters.client_id.trim());
    where.push(`a.client_id = ${p}`);
  }

  if (filters.statut) {
    const p = push(filters.statut);
    where.push(`a.statut = ${p}`);
  }

  if (filters.type_affaire) {
    const p = push(filters.type_affaire);
    where.push(`a.type_affaire = ${p}`);
  }

  if (filters.open_from) {
    const p = push(filters.open_from);
    where.push(`a.date_ouverture >= ${p}::date`);
  }

  if (filters.open_to) {
    const p = push(filters.open_to);
    where.push(`a.date_ouverture <= ${p}::date`);
  }

  if (filters.close_from) {
    const p = push(filters.close_from);
    where.push(`a.date_cloture >= ${p}::date`);
  }

  if (filters.close_to) {
    const p = push(filters.close_to);
    where.push(`a.date_cloture <= ${p}::date`);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    values,
  };
}

function includesSet(includeValue: string) {
  return new Set(
    includeValue
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
  );
}

export async function repoListAffaires(filters: ListAffairesQueryDTO) {
  const includes = includesSet(filters.include ?? "");
  const includeClient = includes.has("client");

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const joinClientSql = includeClient ? "LEFT JOIN clients c ON c.client_id = a.client_id" : "";
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

  const { whereSql, values } = buildListWhere(filters, includeClient);
  const orderBy = sortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM affaire a
    ${joinClientSql}
    ${whereSql}
  `;
  const countRes = await pool.query<{ total: number }>(countSql, values);
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      a.id::text AS id,
      a.reference,
      a.client_id,
      a.commande_id::text AS commande_id,
      a.devis_id::text AS devis_id,
      a.type_affaire,
      a.statut,
      a.date_ouverture::text AS date_ouverture,
      a.date_cloture::text AS date_cloture,
      a.commentaire,
      a.created_at::text AS created_at,
      a.updated_at::text AS updated_at,
      ${clientSelectSql}
    FROM affaire a
    ${joinClientSql}
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  type AffaireListRow = Omit<AffaireListItem, "id" | "commande_id" | "devis_id"> & {
    id: string;
    commande_id: string | null;
    devis_id: string | null;
    client: ClientLite | null;
  };

  const dataRes = await pool.query<AffaireListRow>(dataSql, [...values, pageSize, offset]);
  const items: AffaireListItem[] = dataRes.rows.map((r) => ({
    ...r,
    id: toInt(r.id, "affaire.id"),
    commande_id: toNullableInt(r.commande_id, "affaire.commande_id"),
    devis_id: toNullableInt(r.devis_id, "affaire.devis_id"),
    client: includeClient ? r.client : undefined,
  }));

  return { items, total };
}

export async function repoGetAffaire(id: number, includeValue: string) {
  const includes = includesSet(includeValue);
  const includeClient = includes.has("client");
  const includeCommande = includes.has("commande");
  const includeDevis = includes.has("devis");

  const joinClientSql = includeClient ? "LEFT JOIN clients c ON c.client_id = a.client_id" : "";
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

  const sql = `
    SELECT
      a.id::text AS id,
      a.reference,
      a.client_id,
      a.commande_id::text AS commande_id,
      a.devis_id::text AS devis_id,
      a.type_affaire,
      a.statut,
      a.date_ouverture::text AS date_ouverture,
      a.date_cloture::text AS date_cloture,
      a.commentaire,
      a.created_at::text AS created_at,
      a.updated_at::text AS updated_at,
      ${clientSelectSql}
    FROM affaire a
    ${joinClientSql}
    WHERE a.id = $1
  `;

  type BaseRow = Omit<Affaire, "id" | "commande_id" | "devis_id" | "client" | "commande" | "devis"> & {
    id: string;
    commande_id: string | null;
    devis_id: string | null;
    client: ClientLite | null;
  };

  const baseRes = await pool.query<BaseRow>(sql, [id]);
  const r = baseRes.rows[0] ?? null;
  if (!r) return null;

  const affaire: Affaire = {
    ...r,
    id: toInt(r.id, "affaire.id"),
    commande_id: toNullableInt(r.commande_id, "affaire.commande_id"),
    devis_id: toNullableInt(r.devis_id, "affaire.devis_id"),
    client: includeClient ? r.client : undefined,
  };

  if (includeCommande && affaire.commande_id) {
    const commandeSql = `
      SELECT
        cc.id::text AS id,
        cc.numero,
        cc.client_id,
        cc.date_commande::text AS date_commande,
        cc.total_ht::float8 AS total_ht,
        cc.total_ttc::float8 AS total_ttc,
        cc.updated_at::text AS updated_at,
        COALESCE(st.nouveau_statut, 'brouillon') AS statut
      FROM commande_client cc
      LEFT JOIN LATERAL (
        SELECT ch.nouveau_statut
        FROM commande_historique ch
        WHERE ch.commande_id = cc.id
        ORDER BY ch.date_action DESC, ch.id DESC
        LIMIT 1
      ) st ON TRUE
      WHERE cc.id = $1
    `;

    type CmdRow = Omit<CommandeHeaderLite, "id"> & { id: string };
    const cmdRes = await pool.query<CmdRow>(commandeSql, [affaire.commande_id]);
    const cmd = cmdRes.rows[0] ?? null;
    affaire.commande = cmd
      ? {
          ...cmd,
          id: toInt(cmd.id, "commande.id"),
        }
      : null;
  }

  if (includeDevis && affaire.devis_id) {
    const devisSql = `
      SELECT
        d.id::text AS id,
        d.numero,
        d.client_id,
        d.date_creation::text AS date_creation,
        d.date_validite::text AS date_validite,
        d.statut,
        d.total_ht::float8 AS total_ht,
        d.total_ttc::float8 AS total_ttc
      FROM devis d
      WHERE d.id = $1
    `;
    type DevisRow = Omit<DevisHeaderLite, "id"> & { id: string };
    const devisRes = await pool.query<DevisRow>(devisSql, [affaire.devis_id]);
    const devis = devisRes.rows[0] ?? null;
    affaire.devis = devis
      ? {
          ...devis,
          id: toInt(devis.id, "devis.id"),
        }
      : null;
  }

  return affaire;
}

export async function repoCreateAffaire(input: CreateAffaireBodyDTO) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const seqRes = await client.query<{ id: string }>(
      `SELECT nextval('public.affaire_id_seq')::bigint::text AS id`
    );
    const idRaw = seqRes.rows[0]?.id;
    if (!idRaw) throw new Error("Failed to allocate affaire id");
    const id = toInt(idRaw, "affaire.id");

    const reference = (input.reference ?? `AFF-${id}`).slice(0, 30);

    const insertSql = `
      INSERT INTO affaire (
        id,
        reference,
        client_id,
        commande_id,
        devis_id,
        type_affaire,
        statut,
        date_ouverture,
        date_cloture,
        commentaire
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,
        COALESCE($8::date, CURRENT_DATE),
        $9::date,
        $10
      )
      RETURNING id::text AS id
    `;

    const ins = await client.query<{ id: string }>(insertSql, [
      id,
      reference,
      input.client_id,
      input.commande_id ?? null,
      input.devis_id ?? null,
      input.type_affaire,
      input.statut,
      input.date_ouverture ?? null,
      input.date_cloture ?? null,
      input.commentaire ?? null,
    ]);

    await client.query("COMMIT");
    const insertedId = ins.rows[0]?.id;
    return { id: insertedId ? toInt(insertedId, "affaire.id") : id };
  } catch (err) {
    await client.query("ROLLBACK");

    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "affaire_reference_key") {
      throw new HttpError(409, "AFFAIRE_REFERENCE_EXISTS", "Reference already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateAffaire(id: number, input: UpdateAffaireBodyDTO) {
  const sets: string[] = [];
  const values: unknown[] = [id];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (input.reference !== undefined) {
    sets.push(`reference = ${push(input.reference)}`);
  }
  if (input.client_id !== undefined) {
    sets.push(`client_id = ${push(input.client_id)}`);
  }
  if (input.commande_id !== undefined) {
    sets.push(`commande_id = ${push(input.commande_id)}::bigint`);
  }
  if (input.devis_id !== undefined) {
    sets.push(`devis_id = ${push(input.devis_id)}::bigint`);
  }
  if (input.type_affaire !== undefined) {
    sets.push(`type_affaire = ${push(input.type_affaire)}`);
  }
  if (input.date_ouverture !== undefined) {
    sets.push(`date_ouverture = ${push(input.date_ouverture)}::date`);
  }
  if (input.commentaire !== undefined) {
    sets.push(`commentaire = ${push(input.commentaire)}`);
  }

  if (input.statut !== undefined) {
    sets.push(`statut = ${push(input.statut)}`);
    if (input.statut === "CLOTUREE") {
      if (input.date_cloture) {
        sets.push(`date_cloture = ${push(input.date_cloture)}::date`);
      } else {
        sets.push(`date_cloture = COALESCE(date_cloture, CURRENT_DATE)`);
      }
    } else if (input.date_cloture !== undefined) {
      sets.push(`date_cloture = ${push(input.date_cloture)}::date`);
    }
  } else if (input.date_cloture !== undefined) {
    sets.push(`date_cloture = ${push(input.date_cloture)}::date`);
  }

  if (sets.length === 0) {
    return null;
  }

  sets.push(`updated_at = now()`);

  const sql = `
    UPDATE affaire
    SET ${sets.join(", ")}
    WHERE id = $1
    RETURNING id::text AS id
  `;

  try {
    const res = await pool.query<{ id: string }>(sql, values);
    const row = res.rows[0] ?? null;
    if (!row) return null;
    return { id: toInt(row.id, "affaire.id") };
  } catch (err) {
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "affaire_reference_key") {
      throw new HttpError(409, "AFFAIRE_REFERENCE_EXISTS", "Reference already exists");
    }
    throw err;
  }
}

export async function repoDeleteAffaire(id: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM commande_to_affaire WHERE affaire_id = $1`, [id]);
    const del = await client.query(`DELETE FROM affaire WHERE id = $1`, [id]);
    await client.query("COMMIT");
    return (del.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
