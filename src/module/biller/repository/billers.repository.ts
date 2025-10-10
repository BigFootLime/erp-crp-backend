// src/module/billers/repository/billers.repository.ts
import pool from "../../../config/database";

export async function repoListBillers(q = "") {
  const like = `%${q.toLowerCase()}%`;
  const { rows } = await pool.query(
    `SELECT biller_id, biller_name
     FROM factureur
     WHERE $1='%%' OR LOWER(biller_name) LIKE $1
     ORDER BY biller_name ASC`,
    [like]
  );
  return rows as Array<{ biller_id: string; biller_name: string }>;
}
