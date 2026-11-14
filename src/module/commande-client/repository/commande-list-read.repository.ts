import type { Pool } from "pg";
import type { CommandeListItem, ClientLite } from "../types/commande-client.types";
import type { ListCommandesQueryDTO } from "../validators/commande-client.validators";

export function createCommandeListReadRepository(deps: {
  pool: Pool;
  buildListWhere: (filters: ListCommandesQueryDTO) => { whereSql: string; values: unknown[] };
  sortColumn: (sortBy: ListCommandesQueryDTO["sortBy"]) => string;
  sortDirection: (sortDir: ListCommandesQueryDTO["sortDir"]) => "ASC" | "DESC";
  normalizedCommandeStatusSql: (column: string) => string;
  toInt: (value: string | number, label?: string) => number;
}) {
  const { pool, buildListWhere, sortColumn, sortDirection, normalizedCommandeStatusSql, toInt } = deps;

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
