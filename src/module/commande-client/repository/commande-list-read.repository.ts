import type { Pool } from "pg";
import type { CommandeListItem, ClientLite } from "../types/commande-client.types";
import type { ListCommandesQueryDTO } from "../validators/commande-client.validators";

function sortColumn(sortBy: ListCommandesQueryDTO["sortBy"]) {
  switch (sortBy) {
    case "numero":
      return "cc.numero";
    case "date_commande":
      return "cc.date_commande";
    case "updated_at":
      return "cc.updated_at";
    case "total_ttc":
      return "cc.total_ttc";
    default:
      return "cc.updated_at";
  }
}

function sortDirection(sortDir: ListCommandesQueryDTO["sortDir"]) {
  return sortDir === "asc" ? "ASC" : "DESC";
}

type ListWhere = { whereSql: string; values: unknown[] };


export function createCommandeListReadRepository(deps: {
  pool: Pool;
  normalizedCommandeStatusSql: (column: string) => string;
  toInt: (value: string | number, label?: string) => number;
}) {
  const { pool, normalizedCommandeStatusSql, toInt } = deps;

  function buildListWhere(filters: ListCommandesQueryDTO): ListWhere {
    const where: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };
  
    if (filters.q && filters.q.trim().length > 0) {
      const p = push(`%${filters.q.trim()}%`);
      where.push(`(cc.numero ILIKE ${p} OR c.company_name ILIKE ${p} OR cc.code_client ILIKE ${p})`);
    }
  
    if (filters.client_id && filters.client_id.trim().length > 0) {
      const p = push(filters.client_id.trim());
      where.push(`cc.client_id = ${p}`);
    }
  
    if (filters.statut && filters.statut.trim().length > 0) {
      const p = push(filters.statut.trim());
      where.push(`(${normalizedCommandeStatusSql("st.nouveau_statut")}) = ${p}`);
    }
  
    if (filters.order_type) {
      const p = push(filters.order_type);
      where.push(`cc.order_type = ${p}`);
    }
  
    if (filters.from && filters.from.trim().length > 0) {
      const p = push(filters.from.trim());
      where.push(`cc.date_commande >= ${p}::date`);
    }
  
    if (filters.to && filters.to.trim().length > 0) {
      const p = push(filters.to.trim());
      where.push(`cc.date_commande <= ${p}::date`);
    }
  
    if (typeof filters.min_total_ttc === "number" && Number.isFinite(filters.min_total_ttc)) {
      const p = push(filters.min_total_ttc);
      where.push(`cc.total_ttc >= ${p}`);
    }
  
    if (typeof filters.max_total_ttc === "number" && Number.isFinite(filters.max_total_ttc)) {
      const p = push(filters.max_total_ttc);
      where.push(`cc.total_ttc <= ${p}`);
    }
  
    if (filters.mine_recent) {
      where.push(`cc.updated_at >= (now() - interval '30 days')`);
    }
  
    return {
      whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
      values,
    };
  }

  async function repoListCommandes(filters: ListCommandesQueryDTO) {
    const page = filters.page ?? 1;
    const pageSize = filters.pageSize ?? 20;
    const offset = (page - 1) * pageSize;
  
    const { whereSql, values } = buildListWhere(filters);
    const orderBy = sortColumn(filters.sortBy);
    const orderDir = sortDirection(filters.sortDir);
  
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM commande_client cc
      LEFT JOIN clients c ON c.client_id = cc.client_id
      LEFT JOIN LATERAL (
        SELECT ch.nouveau_statut
        FROM commande_historique ch
        WHERE ch.commande_id = cc.id
        ORDER BY ch.date_action DESC, ch.id DESC
        LIMIT 1
      ) st ON TRUE
      ${whereSql}
    `;
    const countRes = await pool.query<{ total: number }>(countSql, values);
    const total = countRes.rows[0]?.total ?? 0;
  
    const dataSql = `
      SELECT
        cc.id::text AS id,
        cc.numero,
        cc.client_id,
        cc.order_type,
        EXISTS(SELECT 1 FROM public.client_contract_calls call WHERE call.commande_id=cc.id) AS has_contract_call,
        cc.date_commande::text AS date_commande,
        cc.total_ht::float8 AS total_ht,
        cc.total_ttc::float8 AS total_ttc,
        cc.updated_at::text AS updated_at,
        ${normalizedCommandeStatusSql("st.nouveau_statut")} AS statut,
        CASE WHEN c.client_id IS NULL THEN NULL ELSE jsonb_build_object(
          'client_id', c.client_id,
          'company_name', c.company_name,
          'email', c.email,
          'phone', c.phone,
          'delivery_address_id', c.delivery_address_id::text,
          'bill_address_id', c.bill_address_id::text
        ) END AS client
      FROM commande_client cc
      LEFT JOIN clients c ON c.client_id = cc.client_id
      LEFT JOIN LATERAL (
        SELECT ch.nouveau_statut
        FROM commande_historique ch
        WHERE ch.commande_id = cc.id
        ORDER BY ch.date_action DESC, ch.id DESC
        LIMIT 1
      ) st ON TRUE
      ${whereSql}
      ORDER BY ${orderBy} ${orderDir}
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `;
    const dataValues = [...values, pageSize, offset];
    type CommandeListRow = Omit<CommandeListItem, "id"> & {
      id: string;
      client: ClientLite | null;
    };
  
    const dataRes = await pool.query<CommandeListRow>(dataSql, dataValues);
  
    const items = dataRes.rows.map((r) => ({
      ...r,
      id: toInt(r.id, "id"),
    }));
  
    return { items, total };
  }
  

  return { repoListCommandes };
}
