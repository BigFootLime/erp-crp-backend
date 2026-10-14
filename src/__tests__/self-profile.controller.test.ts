import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn(),update:vi.fn(),client:vi.fn(),call:vi.fn(),validate:vi.fn(),project:vi.fn(),avatar:vi.fn()}));
vi.mock('../config/database',()=>({default:{}}));
vi.mock('../module/auth/repository/self-profile.repository',()=>({readSelfProfile:m.read,updateSelfProfile:m.update}));
vi.mock('../shared-directory/site-runtime',()=>({sharedDirectoryClient:m.client,projectDirectoryIdentity:m.project}));
vi.mock('../shared-directory/avatar.facade',()=>({readDirectoryAvatar:m.avatar}));
import {patchSelfProfile} from '../module/auth/controllers/self-profile.controller';
beforeEach(()=>{vi.clearAllMocks();m.client.mockReturnValue(null);m.read.mockResolvedValue({id:42,name:'MARTIN'});m.avatar.mockResolvedValue({avatar_key:'duck',profile_picture_asset:null});});
function invoke(body:unknown,user:unknown={id:42}){const req={body,user,headers:{},socket:{remoteAddress:'127.0.0.1'}} as never,res={json:vi.fn()} as never,next=vi.fn();return {req,res,next,run:()=>patchSelfProfile(req,res,next)};}
describe('own profile controller',()=>{
 it('always targets the authenticated actor in legacy mode',async()=>{const x=invoke({surname:' élise '});await x.run();expect(m.update).toHaveBeenCalledWith(42,{surname:'ÉLISE'},expect.any(Object));expect(x.next).not.toHaveBeenCalled();});
 it('rejects target IDs and privileges before any mutation',async()=>{const x=invoke({name:'MARTIN',id:7,is_superadmin:true});await x.run();expect(x.next).toHaveBeenCalledOnce();expect(m.update).not.toHaveBeenCalled();expect(m.call).not.toHaveBeenCalled();});
 it('updates through the common authority and projects its fresh identity',async()=>{m.client.mockReturnValue({call:m.call,validate:m.validate});m.validate.mockResolvedValue({profile_id:'opaque'});const x=invoke({avatar_key:'duck'},{id:42,directory_session:'dir_fixture'});await x.run();expect(m.call).toHaveBeenCalledWith('profile-self-update',{directory_session:'dir_fixture',input:{avatar_key:'duck'},meta:expect.any(Object)});expect(m.update).not.toHaveBeenCalled();expect(m.project).toHaveBeenCalledWith({}, {profile_id:'opaque'});expect(x.next).not.toHaveBeenCalled();});
 it('fails closed without the common session',async()=>{m.client.mockReturnValue({call:m.call});const x=invoke({name:'MARTIN'});await x.run();expect(x.next.mock.calls[0][0]).toMatchObject({status:401,code:'DIRECTORY_SESSION_REQUIRED'});expect(m.call).not.toHaveBeenCalled();expect(m.update).not.toHaveBeenCalled();});
});
