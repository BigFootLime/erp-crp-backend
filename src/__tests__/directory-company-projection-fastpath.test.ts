import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({call:vi.fn(),query:vi.fn(),connect:vi.fn(),project:vi.fn()}));
vi.mock('../shared-directory/site-runtime',()=>({sharedDirectoryClient:()=>({call:mocks.call}),projectDirectoryProfile:mocks.project}));

import {synchronizeDirectoryCompany} from '../shared-directory/company.projection';

const profile={
 profile_id:'00000000-0000-4000-8000-000000000001',source_user_id:7,database:'cerp_prod',username:'operator',name:'Operator',surname:'One',email:'operator@example.test',avatar_key:null,avatar_asset_id:null,tel_no:null,
 role:'Operator',roles:['Operator'],is_superadmin:false,status:'Active',job_title:null,employment_type:null,weekly_hours_target:null,work_profile_incomplete:false,mfa_reenrollment_required:false,work_profile:null,work_profile_start_date:null,
};

describe('directory company projection current revision',()=>{
 beforeEach(()=>vi.clearAllMocks());
 it('does not project creators or acquire the company lock when the local revision already matches',async()=>{
  mocks.call.mockResolvedValue({revision:7,primary_biller_id:null,billers:[],mentions:[],profiles:[profile]});
  mocks.query.mockResolvedValue({rows:[{revision:7}]});
  const db={query:mocks.query,connect:mocks.connect} as any;

  await expect(synchronizeDirectoryCompany(db,'directory-session')).resolves.toBeUndefined();

  expect(mocks.project).not.toHaveBeenCalled();
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(String(mocks.query.mock.calls[0]?.[0])).toContain('SELECT revision FROM public.cerp_directory_company_state');
 });
});
