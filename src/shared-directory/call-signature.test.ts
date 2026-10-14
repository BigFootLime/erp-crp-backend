import {describe,expect,it} from 'vitest';
import {signDirectoryCall,verifyDirectoryCall} from './call-signature';
const key='a'.repeat(64),other='b'.repeat(64),body=Buffer.from('{}'),path='/internal/directory/login',keys=new Map([['cerp_test',key],['cerp_prod',other]]);
const lower=(h:Record<string,string>)=>Object.fromEntries(Object.entries(h).map(([k,v])=>[k.toLowerCase(),v]));
describe('fixed-site private directory calls',()=>{
 it('binds the method, body and path to one site',()=>{
  const h=lower(signDirectoryCall('cerp_test',key,'POST',path,body,100000));
  expect(verifyDirectoryCall(h,keys,'POST',path,body,100000).site).toBe('cerp_test');
  for(const changed of [()=>verifyDirectoryCall({...h,'x-cerp-directory-site':'cerp_prod'},keys,'POST',path,body,100000),()=>verifyDirectoryCall(h,keys,'DELETE',path,body,100000),()=>verifyDirectoryCall(h,keys,'POST',path,Buffer.from('{"changed":true}'),100000)])expect(changed).toThrow();
 });
 it('rejects stale or unknown callers and invalid signature length',()=>{
  const h=lower(signDirectoryCall('cerp_test',key,'POST',path,body,100000));
  expect(()=>verifyDirectoryCall(h,keys,'POST',path,body,200000)).toThrow();
  expect(()=>verifyDirectoryCall(h,new Map(),'POST',path,body,100000)).toThrow();
  expect(()=>verifyDirectoryCall({...h,'x-cerp-directory-signature':'0'},keys,'POST',path,body,100000)).toThrow();
 });
});
