import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({connect:vi.fn(),poolQuery:vi.fn(),promote:vi.fn(),activate:vi.fn(),audit:vi.fn()}));
vi.mock('../config/database',()=>({default:{connect:m.connect,query:m.poolQuery}}));
vi.mock('../shared/uploads/secure-upload',()=>({promoteSecureUpload:m.promote,cleanupUploadsAfterConfirmedRollback:vi.fn(),cleanupUploadsAfterReconciledNoCommit:vi.fn(),markUploadCommitAttempted:vi.fn(),markUploadsCommitted:vi.fn(),markUploadCommitUncertain:vi.fn(),markUploadRollbackUncertain:vi.fn()}));
vi.mock('../utils/imageStorage',()=>({getImagesRootPath:()=>'/virtual/images',ensureImagesSubdir:()=>'/virtual/images/avatars'}));
vi.mock('../module/operational-media/services/operational-media-promotion.service',()=>({promoteOperationalImage:m.activate}));
vi.mock('../module/audit-logs/repository/audit-logs.repository',()=>({repoInsertAuditLog:m.audit}));
import {uploadUserAvatar} from '../module/auth/repository/avatar.repository';
const asset='d5e86cc6-e7f0-4ab6-b80c-e4b16eadf8f1',digest='a'.repeat(64);
const input={userId:42,actorId:7,key:'a27fe37d-aeb2-4706-884f-6e5e7412db8a',file:{originalname:'private-name.png',size:100,uploadSecurity:{sha256:digest,scanStatus:'clean'}} as Express.Multer.File,meta:{ip:null,user_agent:null,device_type:null,os:null,browser:null,path:'/admin/users/:id/avatar'}};
let query:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  vi.clearAllMocks();query=vi.fn(async(sql:string)=>{
    if(sql.includes('SELECT id FROM public.users')) return {rows:[{id:42}]};
    return {rows:[]};
  });
  m.connect.mockResolvedValue({query,release:vi.fn()});m.promote.mockResolvedValue('/virtual/images/avatars/server.png');m.activate.mockResolvedValue({activated:true,asset_id:asset,mime_type:'image/png'});m.audit.mockResolvedValue(undefined);
});
describe('user avatar transaction',()=>{
  it('stores a server-generated relative key and clean opaque reference with its audit',async()=>{
    const result=await uploadUserAvatar(input);
    expect(result).toEqual({profile_picture_asset:{asset_id:asset,status:'AVAILABLE'},replayed:false});
    expect(query).toHaveBeenCalledWith('UPDATE public.users SET profile_picture=$2 WHERE id=$1',[42,'avatars/server.png']);
    expect(m.audit.mock.calls[0][0]).toMatchObject({user_id:7,tx:expect.objectContaining({query}),body:{entity_id:'42',details:{asset_id:asset}}});
    expect(JSON.stringify(result)).not.toMatch(/private-name|virtual|storage_key/);
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });
  it.each(['unavailable','infected','pending'])('never acquires a database transaction for a %s scan',async status=>{
    await expect(uploadUserAvatar({...input,file:{...input.file,uploadSecurity:{sha256:digest,scanStatus:status}} as Express.Multer.File})).rejects.toMatchObject({code:'OPERATIONAL_MEDIA_NOT_READY'});
    expect(m.connect).not.toHaveBeenCalled();expect(m.promote).not.toHaveBeenCalled();
  });
  it('replays without writing or promoting another file',async()=>{
    query.mockImplementation(async(sql:string)=>sql.includes('FROM public.user_avatar_commands') ? {rows:[{actor_id:7,user_id:42,sha256:digest,asset_id:asset}]}:sql.includes('SELECT u.avatar_key') ? {rows:[{avatar_key:'duck',profile_picture_asset_id:asset}]}:{rows:[]});
    expect((await uploadUserAvatar(input)).replayed).toBe(true);expect(m.promote).not.toHaveBeenCalled();expect(m.audit).not.toHaveBeenCalled();
  });
  it.each([{actor_id:8},{user_id:43},{sha256:'b'.repeat(64)}])('rejects a reused key for different identity or bytes: %j',async mismatch=>{
    query.mockImplementation(async(sql:string)=>sql.includes('FROM public.user_avatar_commands') ? {rows:[{actor_id:7,user_id:42,sha256:digest,asset_id:asset,...mismatch}]}:{rows:[]});
    await expect(uploadUserAvatar(input)).rejects.toMatchObject({code:'AVATAR_KEY_REUSED'});expect(query).toHaveBeenCalledWith('ROLLBACK');expect(m.promote).not.toHaveBeenCalled();
  });
  it('rolls back when byte verification cannot activate the asset',async()=>{
    m.activate.mockResolvedValue({activated:false,reason:'verification_required'});
    await expect(uploadUserAvatar(input)).rejects.toMatchObject({code:'OPERATIONAL_MEDIA_NOT_READY'});expect(query).toHaveBeenCalledWith('ROLLBACK');expect(m.audit).not.toHaveBeenCalled();
  });
  it('reconciles a lost commit ACK through a fresh command read',async()=>{
    query.mockImplementation(async(sql:string)=>{if(sql==='COMMIT') throw new Error('ACK lost');return {rows:sql.includes('SELECT id FROM public.users') ? [{id:42}]:[]};});
    m.poolQuery.mockResolvedValue({rows:[{asset_id:asset}]});
    expect((await uploadUserAvatar(input)).profile_picture_asset.asset_id).toBe(asset);expect(query).not.toHaveBeenCalledWith('ROLLBACK');expect(m.poolQuery).toHaveBeenCalled();
  });
});
