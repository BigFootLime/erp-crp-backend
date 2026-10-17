import {describe,expect,it} from 'vitest';
import {directorySessionSchema} from '../shared-directory/model';
import {requireDirectoryAdmin} from '../shared-directory/authority';

const passwordSession={
 profile_id:'381c788e-14a5-4947-a291-396a07835090',source_user_id:2,database:'cerp_prod',
 username:'LI',name:'DUPONT',surname:'LI',email:'li@example.test',avatar_key:'robot',avatar_asset_id:null,tel_no:null,
 role:'Employee',roles:['Employee'],is_superadmin:false,status:'Active' as const,
 job_title:null,employment_type:null,weekly_hours_target:null,work_profile_incomplete:true,
 mfa_reenrollment_required:false,global_session_epoch:0,membership_version:1,
 mfa_factor_id:null,mfa_factor_version:null,mfa_verified_at:null,mfa_method:null,
};
describe('Directory password and MFA assurance contract #1372',()=>{
 it('represents genuine password assurance without inventing a factor',()=>{
  expect(directorySessionSchema.parse(passwordSession)).toMatchObject({mfa_factor_id:null,mfa_factor_version:null,mfa_verified_at:null,mfa_method:null});
 });
 it.each([
  {mfa_factor_id:'b5d291db-e115-46ef-b7fa-f5ee6a104bd1'},
  {mfa_factor_version:1},
  {mfa_verified_at:new Date().toISOString()},
  {mfa_method:'totp'},
 ])('rejects partial assurance instead of promoting password login to MFA: %j',partial=>{
  expect(directorySessionSchema.safeParse({...passwordSession,...partial}).success).toBe(false);
 });
 it('rejects a SuperAdmin session with only password assurance',()=>{
  expect(directorySessionSchema.safeParse({...passwordSession,is_superadmin:true}).success).toBe(false);
 });
 it('requires a fresh factor for administration and returns the client step-up status',()=>{
  const session=directorySessionSchema.parse({...passwordSession,is_superadmin:true,
   mfa_factor_id:'b5d291db-e115-46ef-b7fa-f5ee6a104bd1',mfa_factor_version:1,
   mfa_verified_at:new Date(Date.now()-301_000).toISOString(),mfa_method:'totp',
  });
  expect(()=>requireDirectoryAdmin(session)).toThrowError(expect.objectContaining({status:428,code:'MFA_STEP_UP_REQUIRED'}));
  expect(()=>requireDirectoryAdmin({...session,mfa_verified_at:new Date().toISOString()})).not.toThrow();
 });
});
