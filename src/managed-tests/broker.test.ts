import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServer,request as httpRequest,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import request from 'supertest';
import {createManagedTestBroker} from './broker';
import {ManagedRegistry} from './registry';
import {ManagerError} from './model';
let root:string,broker:ReturnType<typeof createManagedTestBroker>,apis:Server[];
const helper={status:vi.fn(),create:vi.fn(),delete:vi.fn()};
async function poolApi(id:string){const api=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({database:id,authorization:req.headers.authorization??null}));});api.on('upgrade',(_req,socket)=>{socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Fixture-Database: ${id}\r\n\r\n`);socket.on('data',b=>socket.write(b));socket.once('end',()=>socket.destroy());socket.once('error',()=>socket.destroy());});await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));apis.push(api);return (api.address() as AddressInfo).port;}
beforeEach(async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),'cerp-managed-broker-'));apis=[];vi.clearAllMocks();helper.status.mockResolvedValue({ready:true,template_version:'fixture-release'});
 helper.create.mockImplementation(async i=>({id:i.id,port:await poolApi(i.id),template_version:'fixture-release'}));helper.delete.mockImplementation(async i=>({id:i.id,port:null,template_version:'fixture-release',deleted:true}));
 broker=createManagedTestBroker({registry:new ManagedRegistry(path.join(root,'registry.json')),helper,commonApi:'http://127.0.0.1:8082/api/v1',origins:[],enabled:true,authorize:async authorization=>{if(authorization!=='Bearer common-fixture') throw new ManagerError(401,'MANAGED_AUTH_REQUIRED','Connexion requise');return 7;}});await broker.initialize();
});
afterEach(async()=>{const closing=broker.shutdown();broker.server.closeAllConnections();await new Promise<void>(r=>broker.server.listening ? broker.server.close(()=>r()):r());await closing;for(const api of apis){api.closeAllConnections();await new Promise<void>(r=>api.close(()=>r()));}if(path.dirname(root)!==path.resolve(os.tmpdir()) || !path.basename(root).startsWith('cerp-managed-broker-')) throw new Error('Fixture cleanup outside target');await fs.rm(root,{recursive:true,force:true});});
const create=(key=randomUUID())=>request(broker.app).post('/api/v1/test-databases').set('Authorization','Bearer common-fixture').set('Idempotency-Key',key).send({});
describe('managed Test broker',()=>{
 it('lists only public metadata and authorizes mutations before provisioning',async()=>{
  expect((await request(broker.app).get('/api/v1/test-databases')).body).toMatchObject({create_available:true,instances:[]});
  expect((await request(broker.app).post('/api/v1/test-databases').set('Idempotency-Key',randomUUID()).send({})).status).toBe(401);expect(helper.create).not.toHaveBeenCalled();
  const result=await create();expect(result.status).toBe(202);await broker.drain();const list=(await request(broker.app).get('/api/v1/test-databases')).body;expect(list.instances[0]).toMatchObject({id:result.body.id,label:'Base Test 2.0',state:'READY'});expect(JSON.stringify(list)).not.toMatch(/actor_id|port|password|127\.0\.0\.1|storage|request_hash/);
 });
 it('routes HTTP to the fixed API of the selected UUID and fails closed for unknown identities',async()=>{
  const one=await create(),two=await create();await broker.drain();
  for(const i of [one,two]){const response=await request(broker.app).post('/api/v1/auth/login').set('X-CERP-Database',i.body.id).set('Authorization','Bearer test-fixture').send({username:'SAME.USER'});expect(response.body).toEqual({database:i.body.id,authorization:'Bearer test-fixture'});}
  for(const id of ['cerp_prod','cerp_test','cerp_test_broken']) expect((await request(broker.app).get('/api/v1/environment').set('X-CERP-Database',id)).status).toBe(400);
  expect((await request(broker.app).get('/api/v1/environment').set('X-CERP-Database',`cerp_test_${'a'.repeat(32)}`)).status).toBe(410);
 });
 it('replays one create command and retries a failed worker without changing number or UUID',async()=>{
  const key=randomUUID();helper.create.mockRejectedValueOnce(new Error('Controlled failure'));
  const first=await create(key);await broker.drain();expect((await request(broker.app).get('/api/v1/test-databases')).body.instances[0].state).toBe('FAILED');
  const again=await request(broker.app).post(`/api/v1/test-databases/${first.body.id}/retry`).set('Authorization','Bearer common-fixture').set('Idempotency-Key',randomUUID()).send({});await broker.drain();expect(again.body).toMatchObject({id:first.body.id,ordinal:2});expect((await create(key)).body.id).toBe(first.body.id);expect(helper.create).toHaveBeenCalledTimes(2);
 });
 it('removes routability immediately on deletion and never calls the helper for protected bases',async()=>{
  const first=await create();await broker.drain();for(const id of ['cerp_prod','cerp_test']) expect((await request(broker.app).delete(`/api/v1/test-databases/${id}`).set('Authorization','Bearer common-fixture').set('Idempotency-Key',randomUUID()).send({confirmation:'x'})).status).toBe(400);
  const deletion=await request(broker.app).delete(`/api/v1/test-databases/${first.body.id}`).set('Authorization','Bearer common-fixture').set('Idempotency-Key',randomUUID()).send({confirmation:'Base Test 2.0'});expect(deletion.status).toBe(202);await broker.drain();expect(helper.delete).toHaveBeenCalledOnce();expect((await request(broker.app).get('/api/v1/environment').set('X-CERP-Database',first.body.id)).status).toBe(410);expect((await request(broker.app).get('/api/v1/test-databases')).body.instances).toEqual([]);
 });
 it('carries the same UUID through a WebSocket upgrade and rejects ambiguous query contexts',async()=>{
  const first=await create();await broker.drain();await new Promise<void>(r=>broker.server.listen(0,'127.0.0.1',r));const port=(broker.server.address() as AddressInfo).port;
  const result=await new Promise<{status:number;database:string|null}>((resolve,reject)=>{const req=httpRequest({host:'127.0.0.1',port,path:`/socket.io/?database=${first.body.id}&transport=websocket`,headers:{Connection:'Upgrade',Upgrade:'websocket'}});req.on('upgrade',(res,socket)=>{const database=String(res.headers['x-fixture-database']);socket.destroy();resolve({status:res.statusCode!,database});});req.once('error',reject);req.end();});expect(result).toEqual({status:101,database:first.body.id});
  expect((await request(broker.app).get(`/socket.io/?database=${first.body.id}&database=cerp_prod`)).status).toBe(400);
 });
});
