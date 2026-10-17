import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({call:vi.fn(),project:vi.fn()}));
vi.mock('../shared-directory/site-runtime',()=>({sharedDirectoryClient:()=>({call:mocks.call}),projectDirectoryProfile:mocks.project}));
import {synchronizeDirectoryActor} from '../shared-directory/actor.runtime';
const profileId='f50b0f8e-e45f-4914-851a-66a3b7688a6f';
const pool={query:vi.fn(async()=>({rows:[{profile_id:profileId}]}))};
describe('Directory actor assurance v2 failure semantics #1372',()=>{
 beforeEach(()=>vi.clearAllMocks());
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
});
