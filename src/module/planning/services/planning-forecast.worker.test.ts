import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({query:vi.fn(),connect:vi.fn(),snapshot:vi.fn(),material:vi.fn(),readiness:vi.fn(),event:vi.fn(),release:vi.fn()}));
vi.mock('../../../config/database',()=>({default:{query:m.query,connect:m.connect}}));
vi.mock('../repository/planning-central.repository',()=>({readCentralSnapshot:m.snapshot,readCentralDependencies:async()=>[{predecessorId:'program:done',successorId:'op:1'}]}));
vi.mock('../../production/repository/of-dossier.repository',()=>({materialWorkflowEnabled:async()=>true}));
vi.mock('../../production/repository/of-material.repository',()=>({readMaterialTx:m.material}));
vi.mock('../../production/repository/operation-readiness.repository',()=>({readOperationReadinessTx:m.readiness}));
vi.mock('../../../shared/realtime/realtime-outbox.service',()=>({enqueueEntityChanged:m.event}));
import {runPlanningForecastOnce} from './planning-forecast.worker';
const start='2026-09-14T08:00:00.000Z',end='2026-09-14T17:00:00.000Z';
beforeEach(()=>{
  vi.resetAllMocks();vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-08T08:00:00Z'));
  m.connect.mockResolvedValue({query:m.query,release:m.release});
  m.query.mockImplementation(async(sql:string)=>({rows:sql.includes('AS acquired')?[{acquired:true}]:sql.includes('SELECT revision')?[{revision:'2'}]:sql.includes('max(id)')?[{id:'9'}]:sql.includes('AS refresh')?[{refresh:false}]:sql.includes('SELECT t.id FROM')?[{id:'op:1'}]:[],rowCount:1}));
  m.material.mockResolvedValue({needs:[{id:'n',operationId:'1',required:100,consumed:0,reserved:60,receivedBlocked:0,blockers:[],promises:[{assigned:40,received:0,due:'2026-09-14'}]}],customerCalls:[]});
  m.readiness.mockResolvedValue({operations:[{id:'1',blockers:[]}]});
  m.snapshot.mockResolvedValue({revision:'2',nextCursor:null,dependencies:[],resources:[{id:'m',label:'Machine',kind:'MACHINE',timezone:'UTC',availability:[{start,end}]}],tasks:[{id:'op:1',ofId:1,operationId:'1',source:'OPERATION',commitment:'COMMITTED',committed:{start:'2026-09-08T08:00:00Z',end:'2026-09-08T09:00:00Z'},resourceIds:['m'],eligibleResourceIds:['m'],blockers:[],estimate:{remainingMinutes:60},locked:false,createdAt:'2026-09-01',priority:1}]});
});
describe('durable planning projection',()=>{
  it('projects after material arrival and preserves the original commitment',async()=>{
    await expect(runPlanningForecastOnce()).resolves.toBe(true);
    const update=m.query.mock.calls.find(([sql])=>sql.includes('SET forecast_start='));
    expect(update?.[1]).toEqual(['op:1',start,'2026-09-14T09:00:00.000Z','[]']);
    expect(m.snapshot.mock.results[0]).toBeDefined();
    expect(m.snapshot.mock.calls[0][0].includeTaskIds).toContain('program:done');
    expect(m.query.mock.calls.some(([sql])=>/UPDATE public.planning_events|SET committed_|SET.*machine_id/.test(sql))).toBe(false);
    expect(m.query).toHaveBeenCalledWith('COMMIT');expect(m.event).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
  it('keeps the durable work pending after a failed projection transaction',async()=>{
    const original=m.query.getMockImplementation()!;
    m.query.mockImplementation(async(sql:string,...args:unknown[])=>{if(sql.includes('SET forecast_start='))throw new Error('write failed');return original(sql,...args);});
    await expect(runPlanningForecastOnce()).rejects.toThrow('write failed');
    expect(m.query).toHaveBeenCalledWith('ROLLBACK');expect(m.query).not.toHaveBeenCalledWith('COMMIT');
    expect(m.query.mock.calls.some(([sql])=>sql.includes('SET processed_at='))).toBe(false);
    expect(m.query).toHaveBeenCalledWith('UPDATE public.planning_forecast_state SET last_error=$1 WHERE singleton',['FORECAST_RECALCULATION_FAILED']);vi.useRealTimers();
  });
});
