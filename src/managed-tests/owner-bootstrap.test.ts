import {describe,expect,it} from 'vitest';
import bcrypt from 'bcryptjs';
import {prepareOwnerBootstrap} from './owner-bootstrap';
const fixture={username:'fixture.owner',name:'Fixture',surname:'Owner',email:'owner@example.test',password:'Fixture!Owner123',weekly_hours:39,employment_type:'CDI',job_title:'Responsable Informatique'};
describe('private directory owner bootstrap',()=>{
 it('retains the requested profile and hashes the password without a pre-enrolled factor',async()=>{
  const result=await prepareOwnerBootstrap(fixture);
  expect(result.profile).toMatchObject({username:'FIXTURE.OWNER',name:'FIXTURE',surname:'OWNER',weekly_hours:39,employment_type:'CDI',avatar_key:null,personal_avatar:null});
  expect(result.authentication).toMatchObject({mfa_required:true,mfa_reenrollment_required:true});
  expect(await bcrypt.compare(fixture.password,result.authentication.password_hash)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(fixture.password);
  expect(result.authorization.is_superadmin).toBe(true);expect(result.directory_mode).toBe('EMPTY_NO_LEGACY_IMPORT');
 });
 it('rejects weak passwords and does not accept permission or MFA overrides',async()=>{
  await expect(prepareOwnerBootstrap({...fixture,password:'weak'})).rejects.toThrow();
  await expect(prepareOwnerBootstrap({...fixture,mfa_required:false})).rejects.toThrow();
 });
});
