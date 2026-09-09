import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../utils/httpError';
import { enrollSchema,ownPinSchema } from './validators/terminals.validators';
const m=vi.hoisted(()=>({requireModule:vi.fn(),receive:vi.fn(),prepare:vi.fn(),finish:vi.fn()}));
vi.mock('./services/terminal-auth.service',()=>({requireModule:m.requireModule}));
vi.mock('../receptions/controllers/grouped-receipts.controller',()=>({expectedReceiptLines:(_q:unknown,r:express.Response)=>r.json({items:[]}),stageGroupedReceipt:(_q:unknown,r:express.Response)=>r.json({}),validateGroupedReceipt:m.receive}));
vi.mock('../production/controllers/consumable-procurement.controller',()=>({readConsumables:(_q:unknown,r:express.Response)=>r.json({needs:[]}),configureConsumable:(_q:unknown,r:express.Response)=>r.json({}),prepareConsumables:m.prepare,withdrawConsumable:(_q:unknown,r:express.Response)=>r.json({}),reconcileConsumables:(_q:unknown,r:express.Response)=>r.json({})}));
vi.mock('../stock/controllers/consumable-supply.controller',()=>({findScannedConsumable:(_q:unknown,r:express.Response)=>r.json({items:[]}),readConsumableSupply:(_q:unknown,r:express.Response)=>r.json({}),prepareConsumableSupply:(_q:unknown,r:express.Response)=>r.json({}),finishConsumablePack:m.finish}));
import router from './routes/terminal-supply.routes';
function app(kind:string){const app=express();app.use(express.json());app.use((req,_res,next)=>{req.terminal={kind} as express.Request['terminal'];req.user={id:7,username:'QA',role:'Opérateur',email:''};next();});app.use(router);app.use((e:HttpError,_q:express.Request,r:express.Response,_n:express.NextFunction)=>r.status(e.status??500).json({code:e.code}));return app;}
beforeEach(()=>{vi.clearAllMocks();m.requireModule.mockResolvedValue(undefined);for(const fn of [m.receive,m.prepare,m.finish])fn.mockImplementation((_q:unknown,r:express.Response)=>r.json({saved:true}));});
describe('logistics terminals use canonical commands within an explicit application and account boundary',()=>{
  it.each(['OPERATOR','OF_PROCUREMENT'])('refuses receipt confirmation from %s',async kind=>{expect((await request(app(kind)).post('/reception/123/confirm').send({})).status).toBe(403);expect(m.receive).not.toHaveBeenCalled();});
  it.each(['OPERATOR','RECEPTION'])('refuses procurement from %s',async kind=>{expect((await request(app(kind)).post('/procurement/ofs/12/prepare').send({})).status).toBe(403);expect(m.prepare).not.toHaveBeenCalled();});
  it('passes the receipt to the shared controller only with quality module access',async()=>{expect((await request(app('RECEPTION')).post('/reception/123/confirm').send({})).status).toBe(200);expect(m.requireModule).toHaveBeenCalledWith(7,'qualite');expect(m.receive).toHaveBeenCalledOnce();});
  it('requires both production and stock for a pallet write',async()=>{m.requireModule.mockImplementation(async(_id:number,module:string)=>{if(module==='stock')throw new HttpError(403,'DENIED','denied');});expect((await request(app('OF_PROCUREMENT')).post('/procurement/consumables/123/finish-pack').send({})).status).toBe(403);expect(m.finish).not.toHaveBeenCalled();});
  it('rejects receipt reads when quality access was removed',async()=>{m.requireModule.mockRejectedValue(new HttpError(403,'DENIED','denied'));expect((await request(app('RECEPTION')).get('/reception/expected-lines')).status).toBe(403);});
});
describe('terminal enrollment and personal code',()=>{
  const common={label:'QA tablet',site_code:'QA',machine_id:null};
  it.each(['RECEPTION','OF_PROCUREMENT'])('accepts %s with a site and no machine',kind=>{expect(enrollSchema.safeParse({...common,kind}).success).toBe(true);expect(enrollSchema.safeParse({...common,kind,machine_id:'11111111-1111-4111-8111-111111111111'}).success).toBe(false);});
  it('preserves the mandatory operator machine',()=>expect(enrollSchema.safeParse({...common,kind:'OPERATOR'}).success).toBe(false));
  it.each(['123','12345','1a34'])('rejects invalid personal code %s',pin=>expect(ownPinSchema.safeParse({site_code:'QA',pin}).success).toBe(false));
  it('does not allow selecting another user in the personal code command',()=>expect(ownPinSchema.safeParse({site_code:'QA',pin:'0007',user_id:99}).success).toBe(false));
});
