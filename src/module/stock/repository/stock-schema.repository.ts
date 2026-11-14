import type { PoolClient } from "pg";

export async function tableColumnExists(
  queryer: Pick<PoolClient, "query">,
  tableName: string,
  columnName: string
): Promise<boolean> {
  const result = await queryer.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
         AND column_name = $2
     ) AS present`,
    [tableName, columnName]
  );
  return result.rows[0]?.present === true;
}
