import {randomUUID} from 'node:crypto';
import express from 'express';
import type {Server} from 'node:http';
import type {Pool} from 'pg';
import request from 'supertest';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mountApprovedAccountAccessSource,readApprovedAccountAccessSource} from './approved-account-access-source';
import {signDirectoryCall} from './call-signature';

const authority=randomUUID(),profile=randomUUID(),unknownProfile=randomUUID(),key='ba'.repeat(32);
const binding={authority_id:authority,profile_id:profile,source_site:'cerp_test' as const};
const servers:Server[]=[];
const query=vi.fn(),release=vi.fn();
const db={connect:vi.fn(async()=>({query,release}))} as unknown as Pool;

function app(site:'cerp_prod'|'cerp_test'='cerp_test'){
 const result=express();result.use(express.json());
 mountApprovedAccountAccessSource(result,db,{CERP_SHARED_DIRECTORY_ENABLED:'true',CERP_SHARED_DIRECTORY_SITE:site,CERP_SHARED_DIRECTORY_ID:authority,CERP_DIRECTORY_SITE_CALL_KEY:key});
 result.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code??'ERROR'}));return result;
}
async function transport(){
 const server=app().listen(0,'127.0.0.1');servers.push(server);await new Promise<void>(resolve=>server.once('listening',resolve));
 const port=(server.address() as {port:number}).port;
 return (async(url:string|URL|Request,options?:RequestInit)=>{
  expect(String(url)).toBe('http://127.0.0.1:8082/internal/cerp/approved-account-access-v1');
  return fetch(`http://127.0.0.1:${port}/internal/cerp/approved-account-access-v1`,options);
 }) as typeof fetch;
}
beforeEach(()=>{query.mockReset();release.mockReset();query.mockImplementation(async(sql:string,params?:unknown[])=>{
 if(sql.includes('current_database()'))return {rows:params?.[0]===unknownProfile?[]:[{database:'cerp_test',epoch:'73',id:9,is_superadmin:false}]};
 if(sql.includes('FROM public.app_modules'))return {rows:[
  {module_key:'commerce',is_active:true,is_protected:false,access:'GRANTED'},
  {module_key:'finance',is_active:true,is_protected:false,access:'DENIED'},
  {module_key:'administration',is_active:true,is_protected:true,access:'GRANTED'},
  {module_key:'retired',is_active:false,is_protected:false,access:'GRANTED'},
 ]};
 return {rows:[]};
});});
afterEach(async()=>{while(servers.length){const server=servers.pop()!;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}});

describe('approved account access source',()=>{
 it('returns only current effective ordinary-account grants in one read-only snapshot',async()=>{
  const snapshot=await readApprovedAccountAccessSource(binding,key,await transport());
  expect(snapshot).toMatchObject({...binding,source_epoch:'73',module_keys:['commerce']});
  expect(snapshot.request_nonce).toMatch(/^[a-f0-9-]{36}$/);
  expect(query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  expect(query.mock.calls.some(([sql])=>/^\s*(INSERT|UPDATE|DELETE|SELECT.*FOR\s+UPDATE)/is.test(sql))).toBe(false);
  expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');expect(release).toHaveBeenCalledOnce();
 });
 it('uses the complete catalog for a real SuperAdmin without exporting the flag',async()=>{
  query.mockImplementation(async(sql:string)=>sql.includes('current_database()')?{rows:[{database:'cerp_test',epoch:'73',id:9,is_superadmin:true}]}:sql.includes('FROM public.app_modules')?{rows:[
   {module_key:'administration',is_active:true,is_protected:true,access:'DENIED'},
   {module_key:'retired',is_active:false,is_protected:false,access:null},
  ]}:{rows:[]});
  const snapshot=await readApprovedAccountAccessSource(binding,key,await transport());
  expect(snapshot.module_keys).toEqual(['administration','retired']);
  expect(snapshot).not.toHaveProperty('is_superadmin');
 });
 it('rejects a wrong source site, profile, nonce or response signature without accepting a grant',async()=>{
  await expect(readApprovedAccountAccessSource({...binding,source_site:'cerp_prod'},key,await transport())).rejects.toMatchObject({status:503,code:'DIRECTORY_UNAVAILABLE'});
  expect(query).not.toHaveBeenCalled();
  const send=await transport();let saved:Response|undefined;
  const replay=(async(url:any,options:any)=>{if(!saved)saved=await send(url,options);return saved.clone();}) as typeof fetch;
  await readApprovedAccountAccessSource(binding,key,replay);
  await expect(readApprovedAccountAccessSource(binding,key,replay)).rejects.toMatchObject({status:503});
  await expect(readApprovedAccountAccessSource({...binding,profile_id:unknownProfile},key,await transport())).rejects.toMatchObject({status:503});
  const altered=(async(url:any,options:any)=>{const response=await send(url,options),value=await response.json();value.module_keys.push('forged');return new Response(JSON.stringify(value),{headers:response.headers});}) as typeof fetch;
  await expect(readApprovedAccountAccessSource(binding,key,altered)).rejects.toMatchObject({status:503});
 });
 it('rejects a caller whose signed site does not equal the configured site before database access',async()=>{
  const path='/internal/cerp/approved-account-access-v1',body=Buffer.from(JSON.stringify(binding));
  await request(app()).post(path).set(signDirectoryCall('cerp_prod',key,'POST',path,body)).send(binding).expect(401);
  expect(query).not.toHaveBeenCalled();
 });
});
