import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({call:vi.fn(),query:vi.fn(),connect:vi.fn()}));
vi.mock('../shared-directory/client',()=>({
 LOCAL_DIRECTORY_ENDPOINT:'http://directory.invalid',
 DirectoryClient:class { call=mocks.call; },
}));

import {initializeSharedDirectorySite,projectDirectoryIdentity,projectDirectoryProfile} from '../shared-directory/site-runtime';

const profile={
 profile_id:'00000000-0000-4000-8000-000000000001',source_user_id:7,database:'cerp_prod',username:'operator',name:'Operator',surname:'One',email:'operator@example.test',avatar_key:null,avatar_asset_id:null,tel_no:null,
 role:'Operator',roles:['Operator'],is_superadmin:false,status:'Active',job_title:null,employment_type:null,weekly_hours_target:null,work_profile_incomplete:false,mfa_reenrollment_required:false,work_profile:null,work_profile_start_date:null,
};
const projected={id:7,directory_username:'operator',name:'Operator',surname:'One',directory_email:'operator@example.test',role:'Operator',status:'Active',is_superadmin:false,avatar_key:null,directory_avatar_asset_id:null,tel_no:null,mfa_reenrollment_required:false,directory_profile_metadata:{job_title:null,employment_type:null,weekly_hours_target:null,work_profile_incomplete:false},roles:['Operator'],work_profile_bound:false,source_user_id:7,global_session_epoch:'2',membership_version:3,mfa_factor_id:'00000000-0000-4000-8000-000000000010',mfa_factor_version:4,session_epoch:'3'};
const environment={CERP_SHARED_DIRECTORY_ENABLED:'true',CERP_SHARED_DIRECTORY_SITE:'cerp_prod',CERP_SHARED_DIRECTORY_ID:'00000000-0000-4000-8000-000000000099'};
const session={...profile,global_session_epoch:2,membership_version:3,mfa_factor_id:'00000000-0000-4000-8000-000000000010',mfa_factor_version:4,mfa_verified_at:'2026-10-15T09:00:00.000Z',mfa_method:'totp' as const};

describe('directory profile projection fast path',()=>{
 beforeEach(async()=>{
  vi.clearAllMocks();
  mocks.call.mockResolvedValue({directory_id:environment.CERP_SHARED_DIRECTORY_ID,schema_version:1});
  mocks.query.mockImplementation(async(statement:unknown)=>{
   const sql=String(statement);
   if(sql.includes('current_database'))return {rows:[{database:'cerp_prod'}]};
   if(sql.includes('to_regclass'))return {rows:[{ok:true}]};
   if(sql.includes('FROM public.users u'))return {rows:[projected]};
   return {rows:[]};
  });
  await initializeSharedDirectorySite({query:mocks.query} as any,environment);
 });

 it('uses the one-read fast path only for an identical live authority profile',async()=>{
  const db={query:mocks.query,connect:mocks.connect} as any;
  await expect(projectDirectoryProfile(db,profile)).resolves.toEqual({id:7,session_epoch:3});
  expect(mocks.connect).not.toHaveBeenCalled();
 });

 it('accepts PostgreSQL bigint text only when the live session epochs and MFA version match exactly',async()=>{
  const db={query:mocks.query,connect:mocks.connect} as any;
  await expect(projectDirectoryIdentity(db,session)).resolves.toEqual({id:7,session_epoch:3});
  expect(mocks.connect).not.toHaveBeenCalled();
 });

 it.each([
  ['status',{...profile,status:'Suspended'}],
  ['roles',{...profile,roles:['Operator','Planning']}],
  ['mfa reenrollment',{...profile,mfa_reenrollment_required:true}],
 ])('never skips reconciliation when %s changed',async(_label,changed)=>{
  mocks.connect.mockRejectedValue(new Error('transaction-required'));
  const db={query:mocks.query,connect:mocks.connect} as any;
  await expect(projectDirectoryProfile(db,changed)).rejects.toThrow('transaction-required');
  expect(mocks.connect).toHaveBeenCalledOnce();
 });

 it.each([
  ['global epoch',{...session,global_session_epoch:3}],
  ['membership version',{...session,membership_version:4}],
  ['MFA factor version',{...session,mfa_factor_version:5}],
 ])('never skips reconciliation when the live session %s changed',async(_label,changed)=>{
  mocks.connect.mockRejectedValue(new Error('transaction-required'));
  const db={query:mocks.query,connect:mocks.connect} as any;
  await expect(projectDirectoryIdentity(db,changed)).rejects.toThrow('transaction-required');
  expect(mocks.connect).toHaveBeenCalledOnce();
 });
});
