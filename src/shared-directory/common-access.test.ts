import {randomUUID} from 'node:crypto';
import express from 'express';
import type {Server} from 'node:http';
import type {Pool} from 'pg';
import request from 'supertest';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mountCommonAccessSource,readCommonAccessSource} from './common-access';
import {signDirectoryCall} from './call-signature';
import {pairedDeviceAllowsTarget} from './tablet-pin.operations';

const authority=randomUUID(),profile=randomUUID(),key='ab'.repeat(32);
const binding={authority_id:authority,profile_id:profile,target_site:'cerp_test'};
let server:Server|undefined;
const query=vi.fn(),release=vi.fn();
const db={connect:vi.fn(async()=>({query,release}))} as unknown as Pool;
function app(){const app=express();app.use(express.json());mountCommonAccessSource(app,db,{CERP_SHARED_DIRECTORY_ENABLED:'true',CERP_SHARED_DIRECTORY_SITE:'cerp_prod',CERP_SHARED_DIRECTORY_ID:authority,CERP_DIRECTORY_SITE_CALL_KEY:key});app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code??'ERROR'}));return app;}
async function transport(){
 server=app().listen(0,'127.0.0.1');await new Promise<void>(resolve=>server!.once('listening',resolve));
 const port=(server.address() as {port:number}).port;
 return (async(url:string|URL|Request,options?:RequestInit)=>{expect(String(url)).toBe('http://127.0.0.1:8080/internal/cerp/common-access-v1');return fetch(`http://127.0.0.1:${port}/internal/cerp/common-access-v1`,options);}) as typeof fetch;
}
beforeEach(()=>{query.mockReset();release.mockReset();query.mockImplementation(async(sql:string)=>{
 if(sql.includes('current_database()'))return {rows:[{database:'cerp_prod',epoch:'72',id:9}]};
 if(sql.includes('FROM public.app_modules'))return {rows:[{module_key:'production',allowed:true},{module_key:'rh',allowed:false}]};
 if(sql.includes('app_user_sensitive_capabilities'))return {rows:[{capability:'audit.read'}]};
 return {rows:[]};
});});
afterEach(async()=>{if(server){await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));server=undefined;}});

describe('live common access source',()=>{
 it('binds a Production configuration read to the same current account policy',async()=>{
  const ownBinding={...binding,target_site:'cerp_prod'};
  const policy=await readCommonAccessSource(ownBinding,key,await transport());
  expect(policy).toMatchObject({...ownBinding,epoch:'72'});
 });
 it('reads current Production decisions in one read-only snapshot and binds its reply',async()=>{
  const policy=await readCommonAccessSource(binding,key,await transport());
  expect(policy).toMatchObject({...binding,epoch:'72',modules:[{module_key:'production',allowed:true},{module_key:'rh',allowed:false}],capabilities:['audit.read']});
  expect(policy.request_nonce).toMatch(/^[a-f0-9-]{36}$/);
  expect(query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  expect(query.mock.calls.some(([sql])=>/^\s*(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
  expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');expect(release).toHaveBeenCalledOnce();
 });
 it('reflects a later revocation rather than a historical approval',async()=>{
  const send=await transport(),first=await readCommonAccessSource(binding,key,send);
  query.mockImplementation(async(sql:string)=>sql.includes('current_database()')?{rows:[{database:'cerp_prod',epoch:'73',id:9}]}:sql.includes('FROM public.app_modules')?{rows:[{module_key:'production',allowed:false},{module_key:'rh',allowed:false}]}:{rows:[]});
  const revoked=await readCommonAccessSource(binding,key,send);
  expect(revoked.modules.every(m=>!m.allowed)).toBe(true);expect(revoked.capabilities).toEqual([]);expect(revoked.policy_hash).not.toBe(first.policy_hash);
 });
 it('rejects a valid old response replayed against a fresh request nonce',async()=>{
  const send=await transport();let saved:Response|undefined;
  const replay=(async(url:any,options:any)=>{if(!saved)saved=await send(url,options);return saved.clone();}) as typeof fetch;
  await readCommonAccessSource(binding,key,replay);
  await expect(readCommonAccessSource(binding,key,replay)).rejects.toMatchObject({status:503,code:'DIRECTORY_UNAVAILABLE'});
 });
 it('rejects a modified response and never reuses an old grant after failure',async()=>{
  const send=await transport();
  const altered=(async(url:any,options:any)=>{const response=await send(url,options),value=await response.json();value.modules[1].allowed=true;return new Response(JSON.stringify(value),{headers:response.headers});}) as typeof fetch;
  await expect(readCommonAccessSource(binding,key,altered)).rejects.toMatchObject({status:503,code:'DIRECTORY_UNAVAILABLE'});
  await expect(readCommonAccessSource(binding,key,vi.fn().mockRejectedValue(new Error('offline')))).rejects.toMatchObject({status:503,code:'DIRECTORY_UNAVAILABLE'});
 });
 it('does not serve a policy from a Test pool or another authority',async()=>{
  query.mockImplementation(async(sql:string)=>sql.includes('current_database()')?{rows:[{database:'cerp_test',epoch:'72',id:9}]}:{rows:[]});
  await expect(readCommonAccessSource(binding,key,await transport())).rejects.toMatchObject({status:503});
  expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
 });
 it('rejects an unsigned or wrong-key caller before touching the database',async()=>{
  await request(app()).post('/internal/cerp/common-access-v1').send(binding).expect(401);
  const path='/internal/cerp/common-access-v1',body=Buffer.from(JSON.stringify(binding));
  await request(app()).post(path).set(signDirectoryCall('cerp_prod','cd'.repeat(32),'POST',path,body)).send(binding).expect(401);
  expect(query).not.toHaveBeenCalled();
 });
});

describe('one paired installation across registered bases',()=>{
 const extra='cerp_test_'+ 'a'.repeat(32),known=new Set(['cerp_prod','cerp_test',extra]);
 it.each(['cerp_test',extra])('accepts the same authority-approved device on %s',target=>{
  expect(pairedDeviceAllowsTarget('cerp_prod',target,known,true)).toBe(true);
  expect(pairedDeviceAllowsTarget(target,'cerp_prod',known,true)).toBe(true);
 });
 it('requires real registration and Production authority for crossing a device site',()=>{
  expect(pairedDeviceAllowsTarget('cerp_prod','cerp_test_'+'b'.repeat(32),known,true)).toBe(false);
  expect(pairedDeviceAllowsTarget(extra,'cerp_prod',known,false)).toBe(false);
  expect(pairedDeviceAllowsTarget('cerp_prod',extra,undefined,true)).toBe(false);
  expect(pairedDeviceAllowsTarget(extra,extra,known,false)).toBe(true);
 });
});
