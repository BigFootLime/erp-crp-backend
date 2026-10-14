// src/module/billers/repository/billers.repository.ts
import pool from "../../../config/database";
import {sharedDirectoryClient} from '../../../shared-directory/site-runtime';

export async function repoListBillers(q = "") {
  const like = `%${q.toLowerCase()}%`;
  const { rows } = await pool.query(
    `SELECT biller_id, biller_name
     FROM factureur
     WHERE ($1='%%' OR LOWER(biller_name) LIKE $1)
     ${sharedDirectoryClient()?"AND biller_id IN (SELECT biller_id FROM public.cerp_directory_company_bindings)":''}
     ORDER BY biller_name ASC`,
    [like]
  );
  return rows as Array<{ biller_id: string; biller_name: string }>;
}
