import {describe,it,expect,vi} from 'vitest';
import {authorizeManager} from './authorization';
function source(overrides:{database?:string;superadmin?:boolean;mfa?:boolean;age?:number}={}){return vi.fn(async(url:string)=>new Response(JSON.stringify(url.endsWith('/environment') ? {database:overrides.database??'cerp_test'}:url.endsWith('/auth/access-profile') ? {is_superadmin:overrides.superadmin??true}:{user:{id:7,mfa:overrides.mfa??true,mfa_verified_at:Math.floor(Date.now()/1000)-(overrides.age??0)}}),{status:200})) as unknown as typeof fetch;}
describe('common-Test manager authorization',()=>{
 it('requires an authenticated live common-Test admin with a recent MFA',async()=>{expect(await authorizeManager('Bearer opaque','http://127.0.0.1:8082/api/v1',source())).toBe(7);});
 it.each([{database:'cerp_prod'},{database:'cerp_test_0123456789abcdef0123456789abcdef'},{superadmin:false}])('rejects the wrong authority: %j',async override=>{await expect(authorizeManager('Bearer opaque','http://127.0.0.1:8082/api/v1',source(override))).rejects.toMatchObject({code:'MANAGED_ADMIN_REQUIRED'});});
 it.each([{mfa:false},{age:301},{age:-1}])('requests MFA step-up: %j',async override=>{await expect(authorizeManager('Bearer opaque','http://127.0.0.1:8082/api/v1',source(override))).rejects.toMatchObject({status:428,code:'MFA_STEP_UP_REQUIRED'});});
 it('never accepts a remote authentication authority or an anonymous mutation',async()=>{await expect(authorizeManager(undefined,'http://127.0.0.1:8082/api/v1',source())).rejects.toMatchObject({status:401});await expect(authorizeManager('Bearer x','https://example.test/api/v1',source())).rejects.toThrow('MANAGED_AUTH_SOURCE_INVALID');});
});
