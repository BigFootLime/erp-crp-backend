import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({audit:vi.fn()}));
vi.mock('../module/audit-logs/repository/audit-logs.repository',()=>({repoInsertAuditLog:mocks.audit}));

import {setProductionSuperadminMembership} from './admin.operations';
import type {DirectorySession} from './model';

const actorId='11111111-1111-4111-8111-111111111111';
const targetId='22222222-2222-4222-8222-222222222222';
const factorId='33333333-3333-4333-8333-333333333333';
const actor:DirectorySession={profile_id:actorId,source_user_id:10,database:'cerp_prod',username:'owner',name:'OWNER',surname:'ONE',email:'owner@example.test',avatar_key:null,avatar_asset_id:null,tel_no:null,role:'Administrateur Systeme et Reseau',roles:['Administrateur Systeme et Reseau'],is_superadmin:true,status:'Active',job_title:null,employment_type:null,weekly_hours_target:null,work_profile_incomplete:false,mfa_reenrollment_required:false,work_profile:null,work_profile_start_date:null,global_session_epoch:1,membership_version:2,mfa_factor_id:factorId,mfa_factor_version:1,mfa_verified_at:new Date().toISOString(),mfa_method:'totp'};

function fakeDirectory({targetSuperadmin=false,viable=1,updated=true,afterOwnerLock}:{targetSuperadmin?:boolean;viable?:number;updated?:boolean;afterOwnerLock?:()=>void}={}){
 const calls:string[]=[];
 const tx={query:vi.fn(async(sql:string)=>{
  calls.push(sql);
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK'||sql.startsWith('SELECT id FROM public.user_mfa_factors'))return {rows:[]};
  if(sql.includes('pg_advisory_xact_lock')){afterOwnerLock?.();return {rows:[]};}
  if(sql.includes('AND f.id=$3::uuid'))return {rows:[{ok:1}]};
  if(sql.includes('WHERE m.profile_id=$1::uuid'))return {rows:[{profile_id:targetId,user_id:20,is_superadmin:targetSuperadmin,version:7,status:'Active',user_status:'Active',mfa_reenrollment_required:false}]};
  if(sql.includes('SELECT count(*)::int AS n'))return {rows:[{n:viable}]};
  if(sql.includes("WHERE m.database_id='cerp_prod' AND m.is_superadmin"))return {rows:[{profile_id:actorId,user_id:10},...(targetSuperadmin?[{profile_id:targetId,user_id:20}]:[])]};
  if(sql.startsWith('SELECT 1 FROM public.user_mfa_factors'))return {rows:[{ok:1}]};
  if(sql.startsWith('UPDATE public.cerp_directory_memberships'))return {rows:updated?[{profile_id:targetId,is_superadmin:!targetSuperadmin,version:8}]:[]};
  throw new Error(`Unexpected query: ${sql}`);
 }),release:vi.fn()};
 return {db:{connect:vi.fn(async()=>tx)},tx,calls};
}

describe('Production superAdmin authority mutation',()=>{
 beforeEach(()=>vi.resetAllMocks());

 it('serializes a promotion, requires the authoritative MFA evidence, audits it and bumps the membership version',async()=>{
  const {db,tx,calls}=fakeDirectory();
  await expect(setProductionSuperadminMembership(db as never,actor,{profile_id:targetId,is_superadmin:true,expected_version:7})).resolves.toEqual({profile_id:targetId,is_superadmin:true,version:8,changed:true});
  expect(calls[0]).toBe('BEGIN');
  expect(calls.some(sql=>sql.includes('pg_advisory_xact_lock'))).toBe(true);
  expect(calls.some(sql=>sql.includes('FOR UPDATE OF m,u'))).toBe(true);
  expect(calls.some(sql=>sql.startsWith('UPDATE public.cerp_directory_memberships'))).toBe(true);
  expect(calls.at(-1)).toBe('COMMIT');
  expect(tx.release).toHaveBeenCalledOnce();
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({user_id:10,tx,body:expect.objectContaining({action:'DIRECTORY_SUPERADMIN_CHANGED',details:expect.objectContaining({database:'cerp_prod',membership_version:8})})}));
 });

 it('rolls back a demotion that would leave no active Production owner with MFA',async()=>{
  const {db,calls}=fakeDirectory({targetSuperadmin:true,viable:0});
  await expect(setProductionSuperadminMembership(db as never,actor,{profile_id:targetId,is_superadmin:false,expected_version:7})).rejects.toMatchObject({status:409,code:'LAST_DIRECTORY_OWNER'});
  expect(calls.at(-1)).toBe('ROLLBACK');
  expect(mocks.audit).not.toHaveBeenCalled();
 });

 it('fails closed for a stale membership version and never records a false audit event',async()=>{
  const {db,calls}=fakeDirectory({updated:false});
  await expect(setProductionSuperadminMembership(db as never,actor,{profile_id:targetId,is_superadmin:true,expected_version:7})).rejects.toMatchObject({status:409,code:'DIRECTORY_MEMBERSHIP_STALE'});
  expect(calls.at(-1)).toBe('ROLLBACK');
  expect(mocks.audit).not.toHaveBeenCalled();
 });

 it('refuses a Test context before a directory transaction starts',async()=>{
  const {db}=fakeDirectory();
  await expect(setProductionSuperadminMembership(db as never,{...actor,database:'cerp_test'}, {profile_id:targetId,is_superadmin:true,expected_version:7})).rejects.toMatchObject({status:403,code:'DIRECTORY_PRODUCTION_CONTEXT_REQUIRED'});
  expect(db.connect).not.toHaveBeenCalled();
 });

  it('rechecks MFA freshness after the owner lock without relying on elapsed wall-clock time',async()=>{
    vi.useFakeTimers();
    const checkedAt=new Date('2026-10-15T09:00:00.000Z');
    vi.setSystemTime(checkedAt);
    const {db,calls}=fakeDirectory({afterOwnerLock:()=>vi.setSystemTime(new Date(checkedAt.getTime()+300_001))});
    await expect(setProductionSuperadminMembership(db as never,{...actor,mfa_verified_at:checkedAt.toISOString()},{profile_id:targetId,is_superadmin:true,expected_version:7})).rejects.toMatchObject({status:403,code:'MFA_STEP_UP_REQUIRED'});
    expect(calls.some(sql=>sql.startsWith('UPDATE public.cerp_directory_memberships'))).toBe(false);
    expect(calls.at(-1)).toBe('ROLLBACK');
    expect(mocks.audit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
