import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({call:vi.fn(),project:vi.fn(),common:vi.fn(),companyMode:false}));
vi.mock('../shared-directory/site-runtime',()=>({sharedDirectoryClient:()=>({call:mocks.call}),sharedDirectorySite:()=>"cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_test",projectDirectoryProfile:mocks.project}));
vi.mock('../shared-directory/common-access',()=>({synchronizeCommonAccess:mocks.common}));
vi.mock('../module/entreprises/runtime/company-runtime.config',()=>({companyRuntimeConfiguration:()=>mocks.companyMode?{enabled:true,company_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',environment:'cerp_test'}:{enabled:false}}));
import {synchronizeDirectoryActor} from '../shared-directory/actor.runtime';
const profileId='f50b0f8e-e45f-4914-851a-66a3b7688a6f';
const pool={query:vi.fn(async()=>({rows:[{profile_id:profileId}]}))};
describe('Directory actor assurance v2 failure semantics #1372',()=>{
 beforeEach(()=>{vi.clearAllMocks();mocks.companyMode=false;});
 it('fails closed as a removed actor when its canonical profile is missing',async()=>{
  mocks.call.mockRejectedValue({status:404,code:'USER_NOT_FOUND'});
  await expect(synchronizeDirectoryActor(pool as never,7)).resolves.toBeNull();
  expect(mocks.project).not.toHaveBeenCalled();
 });
 it('keeps an unsupported authority operation as an availability failure, without pretending the account was removed',async()=>{
  mocks.call.mockRejectedValue({status:404,code:'DIRECTORY_OPERATION_UNKNOWN'});
  await expect(synchronizeDirectoryActor(pool as never,7)).rejects.toMatchObject({status:503,code:'DIRECTORY_UNAVAILABLE'});
  expect(mocks.project).not.toHaveBeenCalled();
 });
 it('never projects legacy CommonAccess while an opaque company runtime is enabled',async()=>{
  mocks.companyMode=true;
  mocks.call.mockResolvedValue({profile:{profile_id:profileId,source_user_id:7,database:'cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_test',username:'operator',name:'Operator',surname:'One',email:null,avatar_key:null,avatar_asset_id:null,tel_no:null,role:'Operator',roles:['Operator'],is_superadmin:false,status:'Active',job_title:null,employment_type:null,weekly_hours_target:null,work_profile_incomplete:false,mfa_reenrollment_required:false,work_profile:null,work_profile_start_date:null},global_session_epoch:1,membership_version:1,mfa_factor_id:null,mfa_factor_version:null,mfa_required:false});
  mocks.project.mockResolvedValue({id:7});
  const tx={query:vi.fn(async(sql:string)=>({rows:sql.includes('cerp_directory_actor_state')?[]:sql.includes('session_epoch')?[{epoch:'0'}]:[]})),release:vi.fn()};
  const db={query:vi.fn(async()=>({rows:[{profile_id:profileId}]})),connect:vi.fn(async()=>tx)};
  await synchronizeDirectoryActor(db as never,7);
  expect(mocks.common).not.toHaveBeenCalled();
 });
});
