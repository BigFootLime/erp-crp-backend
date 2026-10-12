import express from 'express';
import type {Request,Response,NextFunction,ErrorRequestHandler} from 'express';
import request from 'supertest';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({read:vi.fn(),save:vi.fn()}));
vi.mock('../config/database',()=>({default:{query:vi.fn(),connect:vi.fn()}}));
vi.mock('../module/client/services/client-urgency-fee.service',()=>({readClientUrgencyFee:mocks.read,saveClientUrgencyFee:mocks.save}));
vi.mock('../module/auth/middlewares/auth.middleware',async()=>({
  ...await vi.importActual<typeof import('../module/auth/middlewares/auth.middleware')>('../module/auth/middlewares/auth.middleware'),
  authenticateToken:(req:Request,res:Response,next:NextFunction)=>{
    const role=req.get('x-fixture-role');if(!role){res.sendStatus(401);return;}
    Object.assign(req,{user:{id:8,role}});next();
  },
}));
import router from '../module/client/routes/client.routes';
const app=express();app.use(express.json());app.use('/clients',router);
app.use(((error,_req,res,_next)=>res.status(error.name==='ZodError'?400:error.status??500).json({code:error.code})) as ErrorRequestHandler);
beforeEach(()=>{vi.clearAllMocks();mocks.read.mockResolvedValue({version:0,amount_ht:null});mocks.save.mockResolvedValue({version:1,amount_ht:'35.50'});});
describe('client urgency tariff HTTP boundary',()=>{
  it('requires authentication for reads and updates',async()=>{
    expect((await request(app).get('/clients/195/urgency-fee')).status).toBe(401);
    expect((await request(app).put('/clients/195/urgency-fee').send({})).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();expect(mocks.save).not.toHaveBeenCalled();
  });
  it('uses the actual client write-role guard',async()=>{
    expect((await request(app).put('/clients/195/urgency-fee').set('x-fixture-role','Operateur')
      .send({expected_version:0,amount_ht:'35.50',currency:'EUR'})).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('validates and audits an authorized update without caching customer tariffs',async()=>{
    const reply=await request(app).put('/clients/195/urgency-fee').set('x-fixture-role','Commercial')
      .send({expected_version:0,amount_ht:'35.5',currency:'eur'});
    expect(reply.status).toBe(200);expect(reply.headers['cache-control']).toBe('private, no-store');
    expect(mocks.save).toHaveBeenCalledWith('195',{expected_version:0,amount_ht:'35.50',currency:'EUR'},
      expect.objectContaining({user_id:8,page_key:'clients.urgency-fee'}));
  });
  it('rejects free-form amounts before the repository',async()=>{
    expect((await request(app).put('/clients/195/urgency-fee').set('x-fixture-role','Commercial')
      .send({expected_version:0,amount_ht:'35 euros',currency:'EUR'})).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
