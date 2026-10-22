import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import type {DirectoryClient} from './client';
const mocks=vi.hoisted(()=>({catalog:vi.fn(),upsert:vi.fn(),audit:vi.fn(),bump:vi.fn()}));
vi.mock('../module/access-control/repository/access-control.repository',()=>({repoListCatalogModules:mocks.catalog,repoUpsertUserModuleAccess:mocks.upsert}));
vi.mock('../module/audit-logs/repository/audit-logs.repository',()=>({repoInsertAuditLog:mocks.audit}));
vi.mock('../shared/realtime/realtime-control-plane',()=>({bumpRealtimeAuthorizationEpoch:mocks.bump}));
import {synchronizeCommonAccess} from './common-access';

const authority=randomUUID(),profile=randomUUID();
let previous:{epoch:string;hash:string}|undefined;
const query=vi.fn(),release=vi.fn(),connect=vi.fn(async()=>({query,release}));
const db={connect} as unknown as Pool;
function policy(epoch='1',granted=true){
 const data={authority_id:authority,profile_id:profile,target_site:'cerp_test',epoch,modules:[{module_key:'production',allowed:granted},{module_key:'rh',allowed:false}],capabilities:granted?['audit.read']:[]};
 return {...data,policy_hash:createHash('sha256').update(JSON.stringify(data)).digest('hex'),request_nonce:randomUUID(),issued_at:Math.floor(Date.now()/1000)};
}
const client=(value:unknown)=>({commonAccessPolicy:vi.fn(async()=>value)}) as unknown as DirectoryClient;
beforeEach(()=>{
 vi.stubEnv('CERP_SHARED_DIRECTORY_ID',authority);previous=undefined;
 query.mockReset();connect.mockClear();release.mockClear();Object.values(mocks).forEach(mock=>mock.mockReset());
 mocks.catalog.mockResolvedValue([{module_key:'production',is_active:true,is_protected:false},{module_key:'rh',is_active:true,is_protected:false}]);
 query.mockImplementation(async(sql:string)=>{
  if(sql.includes('SELECT id FROM public.users'))return {rows:[{id:7}]};
  if(sql.includes("details->>'source_epoch'"))return {rows:previous?[previous]:[]};
  if(sql.includes('SELECT module_key,access'))return {rows:[{module_key:'production',access:'GRANTED'},{module_key:'rh',access:'GRANTED'}]};
  if(sql.includes('SELECT capability'))return {rows:[{capability:'audit.read'}]};
  return {rows:[],rowCount:1};
 });
});
afterEach(()=>vi.unstubAllEnvs());
describe('common access is projected before Test authorization',()=>{
 it('closes unselected modules instead of applying defaults or a Test administrator role',async()=>{
  await synchronizeCommonAccess(db,client({policy:policy()}),'cerp_test',profile);
  expect(mocks.upsert).toHaveBeenCalledWith(expect.anything(),{userId:7,moduleKey:'rh',access:'DENIED',updatedBy:7});
  expect(query.mock.calls.some(([sql])=>/SET.*is_superadmin|password|user_mfa|tablet_pin/i.test(sql))).toBe(false);
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({user_id:7,body:expect.objectContaining({action:'DIRECTORY_COMMON_ACCESS_PROJECTED',entity_id:profile,details:expect.objectContaining({source_epoch:'1',source:'server_directory_projection'})})}));
  expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
 });
 it('revokes an existing Test module and sensitive grant when Production revokes them',async()=>{
  const first=policy();previous={epoch:'1',hash:first.policy_hash};
  await synchronizeCommonAccess(db,client({policy:policy('2',false)}),'cerp_test',profile);
  expect(mocks.upsert).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({moduleKey:'production',access:'DENIED'}));
  expect(query.mock.calls.some(([sql])=>sql.includes('SET granted=false'))).toBe(true);expect(mocks.bump).toHaveBeenCalledOnce();
 });
 it('does not rewrite the same revision on another request',async()=>{
  const current=policy();previous={epoch:'1',hash:current.policy_hash};
  await synchronizeCommonAccess(db,client({policy:current}),'cerp_test',profile);
  expect(mocks.upsert).not.toHaveBeenCalled();expect(mocks.audit).not.toHaveBeenCalled();
 });
 it('rejects an older grant arriving after a newer revocation',async()=>{
  const newer=policy('2',false);previous={epoch:'2',hash:newer.policy_hash};
  await expect(synchronizeCommonAccess(db,client({policy:policy()}),'cerp_test',profile)).rejects.toMatchObject({status:503,code:'DIRECTORY_UNAVAILABLE'});
  expect(mocks.upsert).not.toHaveBeenCalled();expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
 });
 it('fails closed on a missing source, altered binding or partial projection',async()=>{
  const offline={commonAccessPolicy:vi.fn().mockRejectedValue(new Error('offline'))} as unknown as DirectoryClient;
  await expect(synchronizeCommonAccess(db,offline,'cerp_test',profile)).rejects.toMatchObject({status:503,code:'DIRECTORY_UNAVAILABLE'});
  expect(connect).not.toHaveBeenCalled();
  await expect(synchronizeCommonAccess(db,client({policy:{...policy(),profile_id:randomUUID()}}),'cerp_test',profile)).rejects.toMatchObject({status:503});
  mocks.upsert.mockRejectedValueOnce(new Error('projection unavailable'));
  await expect(synchronizeCommonAccess(db,client({policy:policy()}),'cerp_test',profile)).rejects.toMatchObject({status:503});
  expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');expect(mocks.audit).not.toHaveBeenCalled();
 });
 it('keeps Test-only registrations isolated and never projects into Production',async()=>{
  const testOnly=client({policy:null});
  await synchronizeCommonAccess(db,testOnly,'cerp_test',profile);expect(connect).not.toHaveBeenCalled();
  await synchronizeCommonAccess(db,testOnly,'cerp_prod',profile);expect(testOnly.commonAccessPolicy).toHaveBeenCalledOnce();
 });
});
