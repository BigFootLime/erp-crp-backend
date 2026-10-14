import {afterEach,beforeEach,describe,it,expect} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {ManagedRegistry} from './registry';
import {databaseLabel} from './model';
let root:string,registry:ManagedRegistry;
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'cerp-managed-registry-'));registry=new ManagedRegistry(path.join(root,'registry.json'));await registry.initialize();});
afterEach(async()=>{await registry.close();if(path.dirname(root)!==path.resolve(os.tmpdir()) || !path.basename(root).startsWith('cerp-managed-registry-')) throw new Error('Fixture cleanup outside its target');await fs.rm(root,{recursive:true,force:true});});
describe('managed Test registry',()=>{
 it('serializes concurrent creation and does not recycle deleted numbers across restart',async()=>{
  const results=await Promise.all(Array.from({length:12},()=>registry.command('CREATE',7,randomUUID())));
  expect(results.map(r=>r.instance.ordinal)).toEqual(Array.from({length:12},(_,i)=>i+2));expect(new Set(results.map(r=>r.instance.id)).size).toBe(12);
  const first=results[0].instance;await registry.update(first.id,{state:'READY',port:23000});await registry.command('DELETE',7,randomUUID(),first.id,databaseLabel(first.ordinal));await registry.update(first.id,{state:'DELETED',port:null});
  await registry.close();registry=new ManagedRegistry(path.join(root,'registry.json'));await registry.initialize();expect((await registry.command('CREATE',7,randomUUID())).instance.ordinal).toBe(14);
 });
 it('binds retry keys to actor and immutable intent',async()=>{
  const key=randomUUID(),first=await registry.command('CREATE',7,key);expect((await registry.command('CREATE',7,key)).instance.id).toBe(first.instance.id);
  await expect(registry.command('CREATE',8,key)).rejects.toMatchObject({code:'MANAGED_KEY_REUSED'});await expect(registry.command('DELETE',7,key,first.instance.id,'wrong')).rejects.toMatchObject({code:'MANAGED_KEY_REUSED'});
 });
 it('cannot delete protected databases or a creation still running',async()=>{
  await expect(registry.command('DELETE',7,randomUUID(),'cerp_prod','Production CERP')).rejects.toMatchObject({code:'MANAGED_NOT_FOUND'});
  await expect(registry.command('DELETE',7,randomUUID(),'cerp_test','Base Test commune')).rejects.toMatchObject({code:'MANAGED_NOT_FOUND'});
  const i=(await registry.command('CREATE',7,randomUUID())).instance;await expect(registry.command('DELETE',7,randomUUID(),i.id,databaseLabel(i.ordinal))).rejects.toMatchObject({code:'MANAGED_BUSY'});
 });
 it('requires the exact display name and resumes a failed creation with the same identity',async()=>{
  const i=(await registry.command('CREATE',7,randomUUID())).instance;await registry.update(i.id,{state:'FAILED',error_code:'MANAGED_OPERATION_FAILED'});
  await expect(registry.command('DELETE',7,randomUUID(),i.id,'Base Test 3.0')).rejects.toMatchObject({code:'MANAGED_CONFIRMATION_REQUIRED'});
  const key=randomUUID(),replay=await registry.command('RETRY',7,key,i.id);expect(replay.instance).toMatchObject({id:i.id,ordinal:2,state:'CREATING'});expect((await registry.command('RETRY',7,key,i.id)).replayed).toBe(true);
 });
 it('refuses a second broker writer',async()=>{await expect(new ManagedRegistry(path.join(root,'registry.json')).initialize()).rejects.toThrow('MANAGED_REGISTRY_ALREADY_RUNNING');});
});
