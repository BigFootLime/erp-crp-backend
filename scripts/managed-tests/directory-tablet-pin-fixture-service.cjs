/* Isolated signed-HTTP authority used by check-tablet-pin-http-1372.cjs. */
const trace=stage=>{if(process.env.CERP_TABLET_PIN_FIXTURE_TRACE==='1')console.error(`TABLET_PIN_FIXTURE_STAGE:${stage}`);};
process.env.NODE_ENV='test';require('ts-node/register/transpile-only');trace('ts-node-ready');
const fs=require('node:fs'),{Pool}=require('pg');trace('before-server-import');const {createDirectoryServer}=require('../../src/shared-directory/server');trace('server-imported');
const keys=new Map(JSON.parse(fs.readFileSync(process.env.CERP_DIRECTORY_CALLERS_FILE,'utf8')).map(({site,key})=>[site,key]));
const server=createDirectoryServer({db:new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000}),directoryId:process.env.CERP_SHARED_DIRECTORY_ID,sourceJwtSecret:process.env.JWT_SECRET,keys});
trace('before-initialize');server.initialize().then(()=>{trace('initialized');server.app.listen(8085,'127.0.0.1',()=>trace('listening'));}).catch(error=>{console.error(error.stack||error);process.exit(1);});
