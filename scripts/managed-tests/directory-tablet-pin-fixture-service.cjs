/* Isolated signed-HTTP authority used by check-tablet-pin-http-1372.cjs. */
process.env.NODE_ENV='test';require('ts-node/register/transpile-only');
const fs=require('node:fs'),{Pool}=require('pg'),{createDirectoryServer}=require('../../src/shared-directory/server');
const keys=new Map(JSON.parse(fs.readFileSync(process.env.CERP_DIRECTORY_CALLERS_FILE,'utf8')).map(({site,key})=>[site,key]));
const server=createDirectoryServer({db:new Pool({connectionString:process.env.DATABASE_URL}),directoryId:process.env.CERP_SHARED_DIRECTORY_ID,sourceJwtSecret:process.env.JWT_SECRET,keys});
server.initialize().then(()=>server.app.listen(8085,'127.0.0.1')).catch(error=>{console.error(error.stack||error);process.exit(1);});
