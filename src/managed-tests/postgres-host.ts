import {Client} from 'pg';
import {spawn} from 'node:child_process';
import type {ManagedHostConfig} from './host-config';
import {requireManagedId} from './model';

export function sqlIdentifier(value:string) {return `"${value.replace(/"/g,'""')}"`;}
export function databaseConnection(base:string,database:string) {const url=new URL(base);url.pathname=`/${database}`;return url.toString();}
export async function withDatabase<T>(base:string,database:string,work:(client:Client)=>Promise<T>) {
  const client=new Client({connectionString:databaseConnection(base,database),connectionTimeoutMillis:5000,statement_timeout:60_000});await client.connect();try{return await work(client);}finally{await client.end();}
}
export async function pgCommand(config:ManagedHostConfig,tool:'pg_dump'|'pg_restore',database:string,args:string[]) {
  const url=new URL(config.admin_database_url);
  return new Promise<void>((resolve,reject)=>{
    const diagnostic=process.env.NODE_ENV==='test' && url.hostname==='127.0.0.1' && url.port==='15463';let stderr='';
    const child=spawn(config[tool],[...args,...(tool==='pg_dump' ? ['--dbname',database]:[])],{shell:false,windowsHide:true,env:{...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:database},stdio:['ignore','ignore',diagnostic ? 'pipe':'ignore']});
    if(diagnostic) child.stderr?.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(0,2000);});
    const timeout=setTimeout(()=>{child.kill();reject(new Error('MANAGED_POSTGRES_COMMAND_TIMEOUT'));},180_000);
    child.once('error',()=>{clearTimeout(timeout);reject(new Error('MANAGED_POSTGRES_TOOL_UNAVAILABLE'));});child.once('exit',code=>{clearTimeout(timeout);if(code && diagnostic) console.error(JSON.stringify({fixture_tool:tool,stage:args.includes('--schema-only')?'schema':args.includes('--data-only')?'catalogues':'restore',diagnostic:stderr}));code===0 ? resolve():reject(new Error('MANAGED_POSTGRES_COMMAND_FAILED'));});
  });
}
export async function assertInstanceMarker(config:ManagedHostConfig,id:string,ordinal:number) {
  requireManagedId(id);return withDatabase(config.admin_database_url,id,async client=>{
    const row=(await client.query<{database_id:string;ordinal:number;template_version:string}>('SELECT database_id,ordinal,template_version FROM public.cerp_managed_instance WHERE singleton=true')).rows[0];
    if(row?.database_id!==id || row.ordinal!==ordinal) throw new Error('MANAGED_DATABASE_MARKER_INVALID');return row;
  });
}
