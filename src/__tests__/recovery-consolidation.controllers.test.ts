import express,{type ErrorRequestHandler} from 'express';
import request from 'supertest';
import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({preview:vi.fn(),apply:vi.fn(),candidates:vi.fn()}));
vi.mock('../module/planning/services/recovery-consolidation.service',()=>({svcPreviewRecoveryGrouping:mocks.preview,svcApplyRecoveryGrouping:mocks.apply,svcListRecoveryGroupingCandidates:mocks.candidates}));
vi.mock('../module/planning/controllers/planning-central.controller',()=>Object.fromEntries([
  'centralApply','centralGetSimulation','centralSimulate','centralSnapshot','centralStatus','centralUnplan','centralObservations',
  'centralPreview','centralWorkshopCalendar','centralSetWorkshopCalendar'].map(name=>[name,vi.fn()])));
vi.mock('../module/planning/controllers/planning-master-plan.controller',()=>({masterPlan:vi.fn()}));
vi.mock('../module/planning/controllers/urgency-approval.controller',()=>({approveRecovery:vi.fn(),previewRecoveryApproval:vi.fn()}));
vi.mock('../module/planning/controllers/planning.controller',()=>({buildAuditContext:(req:express.Request)=>({user_id:req.user!.id,role:req.user!.role})}));
import centralRouter from '../module/planning/routes/planning-central.routes';
import { validationErrorMiddleware } from '../module/auth/middlewares/validationError.middleware';
const id='cfc82e22-f9cc-40a6-b9c7-fb9d5f52ba63',group='6dcae4b0-bb8c-4d75-9dcb-270763a5e5ab';
const url=`/planning/v2/urgency-recoveries/${id}/consolidations/${group}/preview`;
function app(){const server=express();server.use(express.json());
  server.use((req,_res,next)=>{if(req.get('x-test-role'))req.user={id:8,role:req.get('x-test-role')} as Express.User;next();});
  server.use('/planning/v2',centralRouter);server.use(validationErrorMiddleware);
  server.use(((error,_req,res,_next)=>res.status(error.status??500).json({code:error.code})) as ErrorRequestHandler);return server;
}
beforeEach(()=>{vi.clearAllMocks();mocks.preview.mockResolvedValue({read_only:true,feasible:true,issues:[]});});
describe('planner-only recovery grouping preview',()=>{
  it.each([[undefined,401],['Stock',403],['Operateur atelier',403]] as const)('rejects %s',async(role,expected)=>{
    let call=request(app()).get(url);if(role)call=call.set('x-test-role',role);
    expect((await call).status).toBe(expected);expect(mocks.preview).not.toHaveBeenCalled();
  });
  it('returns the private read-only proposal to the planner',async()=>{
    const response=await request(app()).get(url).set('x-test-role','Planification');
    expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({read_only:true,feasible:true});expect(mocks.preview).toHaveBeenCalledWith(id,group);
  });
  it.each([id,group])('validates each UUID (%s)',async invalid=>{
    expect((await request(app()).get(url.replace(invalid,'invalid')).set('x-test-role','Planification')).status).toBe(400);
    expect(mocks.preview).not.toHaveBeenCalled();
  });
  it('keeps preview read-only',async()=>{
    expect((await request(app()).post(url).set('x-test-role','Planification').send({quantity:100})).status).toBe(404);
    expect(mocks.preview).not.toHaveBeenCalled();
  });
});
describe('planner-only recovery grouping application',()=>{
  const endpoint=url.replace('/preview','/apply');
  const body={expected_request_version:1,preview_hash:'a'.repeat(64),proposal_hash:'b'.repeat(64),planning_reference_at:'2026-10-12T08:00:00.000Z',idempotency_key:'6df7ac32-1008-4a2a-9dcc-904465950293'};
  it.each([[undefined,401],['Stock',403],['Operateur atelier',403]] as const)('rejects %s',async(role,expected)=>{
    let call=request(app()).post(endpoint).send(body);if(role)call=call.set('x-test-role',role);
    expect((await call).status).toBe(expected);expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('binds the reviewed proposal and current actor without accepting arbitrary quantities',async()=>{
    mocks.apply.mockResolvedValue({replayed:false,addition:{can_withdraw:false}});
    const response=await request(app()).post(endpoint).set('x-test-role','Planification').send(body);
    expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');
    expect(mocks.apply).toHaveBeenCalledWith(id,group,body,{user_id:8,role:'Planification'});
  });
  it.each([{quantity:20},{producer_id:10},{expected_request_version:0},{preview_hash:'bad'},{planning_reference_at:'12/10/2026'}])('rejects invalid payload %j',async patch=>{
    expect((await request(app()).post(endpoint).set('x-test-role','Planification').send({...body,...patch})).status).toBe(400);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
describe('planner-only grouping discovery',()=>{
  const endpoint=`/planning/v2/urgency-recoveries/${id}/consolidation-candidates`;
  it.each([[undefined,401],['Stock',403],['Operateur atelier',403]] as const)('rejects %s',async(role,status)=>{
    let call=request(app()).get(endpoint);if(role)call=call.set('x-test-role',role);
    expect((await call).status).toBe(status);expect(mocks.candidates).not.toHaveBeenCalled();
  });
  it('parses a bounded page without exposing raw client or technical filters',async()=>{
    mocks.candidates.mockResolvedValue({items:[],next_cursor:null,available:true,reason:null});
    const response=await request(app()).get(endpoint+'?limit=5&cursor=42&q=%20OF-12%20').set('x-test-role','Planification');
    expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');
    expect(mocks.candidates).toHaveBeenCalledWith(id,{limit:5,cursor:42,q:'OF-12'});
  });
  it.each(['limit=101','limit=0','cursor=-1','client_id=other','q='+('a'.repeat(81))])('rejects %s',async query=>{
    expect((await request(app()).get(endpoint+'?'+query).set('x-test-role','Planification')).status).toBe(400);
    expect(mocks.candidates).not.toHaveBeenCalled();
  });
});
