import pool from "../../../config/database";
import type { ClientLite } from "../types/shared.types";
import type { Paginated, TarificationClient, TarificationClientListItem } from "../types/tarification.types";
import type {
  CreateTarificationClientBodyDTO,
  ListTarificationClientsQueryDTO,
  UpdateTarificationClientBodyDTO,
} from "../validators/tarification.validators";

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function includesSet(includeValue: string) {
  return new Set(
    includeValue
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
  );
}

function sortColumn(sortBy: ListTarificationClientsQueryDTO["sortBy"]) {
  switch (sortBy) {
    case "client_id":
      return "tc.client_id";
    case "updated_at":
    default:
      return "tc.updated_at";
  }
}

function sortDirection(sortDir: ListTarificationClientsQueryDTO["sortDir"]) {
  return sortDir === "asc" ? "ASC" : "DESC";
}

type ListWhere = { whereSql: string; values: unknown[] };
function buildListWhere(filters: ListTarificationClientsQueryDTO, includeClientInSearch: boolean): ListWhere {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const p = push(`%${filters.q.trim()}%`);
    if (includeClientInSearch) {
      where.push(`(tc.client_id ILIKE ${p} OR c.company_name ILIKE ${p})`);
    } else {
      where.push(`tc.client_id ILIKE ${p}`);
    }
  }

  if (filters.client_id && filters.client_id.trim().length > 0) {
    const p = push(filters.client_id.trim());
    where.push(`tc.client_id = ${p}`);
  }

  if (filters.active_on) {
    const p = push(filters.active_on);
    where.push(`(tc.valid_from IS NULL OR tc.valid_from <= ${p}::date)`);
    where.push(`(tc.valid_to IS NULL OR tc.valid_to >= ${p}::date)`);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    values,
  };
}

export async function repoListTarificationClients(
  filters: ListTarificationClientsQueryDTO
): Promise<Paginated<TarificationClientListItem>> {
  const includes = includesSet(filters.include ?? "client");
  const includeClient = includes.has("client");
  const joinClient = includeClient || (filters.q ? filters.q.trim().length > 0 : false);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const joinClientSql = joinClient ? "LEFT JOIN clients c ON c.client_id = tc.client_id" : "";
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

  const { whereSql, values } = buildListWhere(filters, joinClient);
  const orderBy = sortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM tarification_client tc
    ${joinClientSql}
    ${whereSql}
  `;
  const countRes = await pool.query<{ total: number }>(countSql, values);
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      tc.id::text AS id,
      tc.client_id,
      tc.remise_globale_pct::float8 AS remise_globale_pct,
      tc.escompte_pct::float8 AS escompte_pct,
      tc.delai_paiement_jours,
      tc.taux_tva_default::float8 AS taux_tva_default,
      tc.valid_from::text AS valid_from,
      tc.valid_to::text AS valid_to,
      tc.updated_at::text AS updated_at,
      ${clientSelectSql}
    FROM tarification_client tc
    ${joinClientSql}
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;
  type Row = Omit<TarificationClientListItem, "id" | "client"> & { id: string; client: ClientLite | null };
  const dataRes = await pool.query<Row>(dataSql, [...values, pageSize, offset]);

  const items: TarificationClientListItem[] = dataRes.rows.map((r) => ({
    ...r,
    id: toInt(r.id, "tarification_client.id"),
    client: includeClient ? r.client : undefined,
  }));

  return { items, total };
}

export async function repoGetTarificationClient(id: number, includeValue: string): Promise<TarificationClient | null> {
  const includes = includesSet(includeValue);
  const includeClient = includes.has("client");

  const joinClientSql = includeClient ? "LEFT JOIN clients c ON c.client_id = tc.client_id" : "";
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
      tc.id::text AS id,
      tc.client_id,
      tc.remise_globale_pct::float8 AS remise_globale_pct,
      tc.escompte_pct::float8 AS escompte_pct,
      tc.delai_paiement_jours,
      tc.taux_tva_default::float8 AS taux_tva_default,
      tc.valid_from::text AS valid_from,
      tc.valid_to::text AS valid_to,
      tc.created_at::text AS created_at,
      tc.updated_at::text AS updated_at,
      ${clientSelectSql}
    FROM tarification_client tc
    ${joinClientSql}
    WHERE tc.id = $1
  `;
  type Row = Omit<TarificationClient, "id" | "client"> & { id: string; client: ClientLite | null };
  const res = await pool.query<Row>(sql, [id]);
  const row = res.rows[0] ?? null;
  if (!row) return null;
  return {
    ...row,
    id: toInt(row.id, "tarification_client.id"),
    client: includeClient ? row.client : undefined,
  };
}

export async function repoCreateTarificationClient(input: CreateTarificationClientBodyDTO) {
  const res = await pool.query<{ id: string }>(
    `
    INSERT INTO tarification_client (
      client_id,
      remise_globale_pct,
      escompte_pct,
      delai_paiement_jours,
      taux_tva_default,
      valid_from,
      valid_to
    ) VALUES (
      $1,$2,$3,$4,$5,
      $6::date,$7::date
    )
    RETURNING id::text AS id
    `,
    [
      input.client_id,
      input.remise_globale_pct,
      input.escompte_pct,
      input.delai_paiement_jours ?? null,
      input.taux_tva_default,
      input.valid_from ?? null,
      input.valid_to ?? null,
    ]
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error("Failed to create tarification_client");
  return { id: toInt(id, "tarification_client.id") };
}

export async function repoUpdateTarificationClient(id: number, input: UpdateTarificationClientBodyDTO) {
  const sets: string[] = [];
  const values: unknown[] = [id];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (input.client_id !== undefined) sets.push(`client_id = ${push(input.client_id)}`);
  if (input.remise_globale_pct !== undefined) sets.push(`remise_globale_pct = ${push(input.remise_globale_pct)}`);
  if (input.escompte_pct !== undefined) sets.push(`escompte_pct = ${push(input.escompte_pct)}`);
  if (input.delai_paiement_jours !== undefined) sets.push(`delai_paiement_jours = ${push(input.delai_paiement_jours)}::int`);
  if (input.taux_tva_default !== undefined) sets.push(`taux_tva_default = ${push(input.taux_tva_default)}`);
  if (input.valid_from !== undefined) sets.push(`valid_from = ${push(input.valid_from)}::date`);
  if (input.valid_to !== undefined) sets.push(`valid_to = ${push(input.valid_to)}::date`);

  if (sets.length === 0) return null;
  sets.push(`updated_at = now()`);

  const sql = `
    UPDATE tarification_client
    SET ${sets.join(", ")}
    WHERE id = $1
    RETURNING id::text AS id
  `;
  const res = await pool.query<{ id: string }>(sql, values);
  const row = res.rows[0] ?? null;
  if (!row) return null;
  return { id: toInt(row.id, "tarification_client.id") };
}

export async function repoDeleteTarificationClient(id: number) {
  const { rowCount } = await pool.query(`DELETE FROM tarification_client WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}
