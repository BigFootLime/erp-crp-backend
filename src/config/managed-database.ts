import type {PoolClient} from 'pg';
const managed=/^cerp_test_[a-f0-9]{32}$/;
export async function connectedTestInfo(q:Pick<PoolClient,'query'>,environment:NodeJS.ProcessEnv=process.env) {
  const database=(await q.query<{database:string}>('SELECT current_database() AS database')).rows[0]?.database;
  const expected=environment.CERP_MANAGED_TEST_ID;
  if(database==='cerp_test' && !expected) return {database,ordinal:1,label:'Base Test commune'};
  if(!database || !expected || database!==expected || !managed.test(database)) return null;
  const row=(await q.query<{database_id:string;ordinal:number}>('SELECT database_id,ordinal FROM public.cerp_managed_instance WHERE singleton=true')).rows[0];
  if(row?.database_id!==database || !Number.isSafeInteger(row.ordinal) || row.ordinal<2) return null;
  return {database,ordinal:row.ordinal,label:`Base Test ${row.ordinal}.0`};
}
export async function assertManagedDatabaseAtStartup(q:Pick<PoolClient,'query'>) {
  if(process.env.CERP_MANAGED_TEST_ID && !await connectedTestInfo(q)) throw new Error('MANAGED_DATABASE_IDENTITY_INVALID');
}
