// Production NAME probe on the disposable loopback cluster, never a business database.
const fs=require('node:fs'),path=require('node:path');
process.env.DATABASE_URL='postgresql://cerp_fixture@127.0.0.1:15463/cerp_test';process.env.CERP_TEST_REGISTRATION_ENABLED='true';process.env.NODE_ENV='test';
require('ts-node/register/transpile-only');
const {Client}=require('pg'),pool=require('../../src/config/database').default;
const {registrationEnabled}=require('../../src/module/auth/repository/test-registration.repository');
const client=new Client({connectionString:'postgresql://cerp_fixture@127.0.0.1:15463/cerp_prod'});
(async()=>{try{
 await client.connect();const {rows}=await client.query('SELECT current_database() AS db,current_user AS actor,inet_server_port() AS port');
 if(rows[0].db!=='cerp_prod' || rows[0].actor!=='cerp_fixture' || rows[0].port!==15463) throw new Error('Isolated probe identity mismatch');
 if(await registrationEnabled(client)) throw new Error('Production signup must remain closed');
 const reportPath=path.resolve(__dirname,'../../docs/testing/evidence/initial-setup-1563-postgres.json'),report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
 const check='actual production database name rejected in isolated cluster with opt-in enabled';
 if(!report.checks.includes(check)) report.checks.push(check);
 const migrations=await pool.query('SELECT count(*)::int AS count FROM public.cerp_schema_migrations');
 report.integration_fixture_migrations=migrations.rows[0].count;
 fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');console.log('Actual isolated production-name boundary PASS');
}catch(error){console.log(error.code ?? error.message);process.exitCode=1;}finally{await client.end();await pool.end();}})();
