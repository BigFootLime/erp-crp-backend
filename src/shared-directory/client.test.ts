import {afterEach,describe,expect,it,vi} from 'vitest';
import {DirectoryClient,LOCAL_DIRECTORY_ENDPOINT,WIREGUARD_DIRECTORY_ENDPOINT} from './client';
import {verifyDirectoryCall} from './call-signature';
const key='ab'.repeat(32);
afterEach(()=>vi.unstubAllGlobals());
describe('private directory transport',()=>{
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
