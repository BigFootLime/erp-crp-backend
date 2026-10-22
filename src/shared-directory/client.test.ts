import {afterEach,describe,expect,it,vi} from 'vitest';
import {DirectoryClient,LOCAL_DIRECTORY_ENDPOINT,WIREGUARD_DIRECTORY_ENDPOINT} from './client';
import {verifyDirectoryCall} from './call-signature';
import {commonAccessReplyMac} from './common-access-signature';
const key='ab'.repeat(32);
afterEach(()=>vi.unstubAllGlobals());
describe('private directory transport',()=>{
 it('binds a common access reply to this site request nonce, including the Test-only result',async()=>{
  let saved:Response|undefined;
  const fetchMock=vi.fn(async(_url:string,options:RequestInit)=>{
   if(saved)return saved.clone();
   const nonce=(options.headers as Record<string,string>)['X-CERP-Directory-Nonce'],bytes=Buffer.from(JSON.stringify({policy:null}));
   saved=new Response(bytes,{headers:{'X-CERP-Common-Access-Site-Signature':commonAccessReplyMac('site',key,nonce,bytes).toString('hex')}});
   return saved.clone();
  });vi.stubGlobal('fetch',fetchMock);
  const directory=new DirectoryClient(LOCAL_DIRECTORY_ENDPOINT,'cerp_test',key);
  await expect(directory.commonAccessPolicy('00000000-0000-4000-8000-000000000000')).resolves.toEqual({policy:null});
  await expect(directory.commonAccessPolicy('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({status:503,code:'DIRECTORY_UNAVAILABLE'});
 });
 it.each([LOCAL_DIRECTORY_ENDPOINT,WIREGUARD_DIRECTORY_ENDPOINT])('signs the same caller, method, path and bytes on %s',async endpoint=>{
  const fetchMock=vi.fn(async(url:string,options:RequestInit)=>{
   expect(url).toBe(`${endpoint}/info`);expect(options.redirect).toBe('error');
   const headers=Object.fromEntries(Object.entries(options.headers as Record<string,string>).map(([name,value])=>[name.toLowerCase(),value]));
   const verified=verifyDirectoryCall(headers,new Map([['cerp_prod',key]]),'POST','/internal/directory/info',options.body as Buffer);
   expect(verified.site).toBe('cerp_prod');expect((options.body as Buffer).toString()).toBe('{}');
   return {ok:true,json:async()=>({ready:true})};
  });vi.stubGlobal('fetch',fetchMock);
  await expect(new DirectoryClient(endpoint,'cerp_prod',key).call('info',{})).resolves.toEqual({ready:true});expect(fetchMock).toHaveBeenCalledTimes(1);
 });
 it.each(['','https://127.0.0.1:8085/internal/directory','http://localhost:8085/internal/directory','http://127.0.0.1:8086/internal/directory','http://10.90.0.2:8085/internal/directory','http://10.90.0.3:8086/internal/directory','http://example.com:8086/internal/directory','http://10.90.0.2:8086/internal/directory/','http://10.90.0.2:8086/internal/directory?target=prod','http://user:password@10.90.0.2:8086/internal/directory','http://10.90.0.2:8086/internal/directory#fragment','http://10.90.0.2:8086/other'])('rejects every unapproved endpoint %s',endpoint=>{
  expect(()=>new DirectoryClient(endpoint,'cerp_prod',key)).toThrow('DIRECTORY_ENDPOINT_INVALID');
 });
 it('does not retry through another endpoint on VPN failure',async()=>{
  const fetchMock=vi.fn().mockRejectedValue(new TypeError('fixture transport failed'));vi.stubGlobal('fetch',fetchMock);
  await expect(new DirectoryClient(WIREGUARD_DIRECTORY_ENDPOINT,'cerp_prod',key).call('info',{})).rejects.toMatchObject({status:503,code:'DIRECTORY_UNAVAILABLE'});
  expect(fetchMock).toHaveBeenCalledTimes(1);
 });
});
