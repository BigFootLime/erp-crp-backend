import {beforeEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn(),load:vi.fn(),evaluate:vi.fn(),persist:vi.fn(),audit:vi.fn()}));
vi.mock('../../../config/database',()=>({default:{connect:async()=>({query:mocks.query})}}));
vi.mock('../../../shared/realtime/realtime-outbox-transaction',()=>({withRealtimeOutboxTransaction:async(tx:unknown,run:(tx:unknown)=>unknown)=>run(tx)}));
vi.mock('./production-preparation.repository',async()=>{
  const actual=await vi.importActual<typeof import('./production-preparation.repository')>('./production-preparation.repository');
  return {...actual,loadPreparationOrder:mocks.load,evaluateOfPreparation:mocks.evaluate,persistPreparationEvaluation:mocks.persist,preparationAudit:mocks.audit};
});
import {repoPrepareOperationProgramming,repoSaveProgrammingTask} from './preparation-actions.repository';
const operationId='00000000-0000-4000-8000-000000000042';
const of={id:7,version_id:operationId,updated_at:'2026-11-03T12:00:00Z',statut:'BROUILLON',technical_snapshot_sha256:null};
const input={expected_updated_at:of.updated_at,operation_id:operationId,operation_hash:'a'.repeat(64),estimated_hours:1.5};
const audit={user_id:7} as Parameters<typeof repoPrepareOperationProgramming>[2];
beforeEach(()=>{vi.clearAllMocks();mocks.load.mockResolvedValue(of);mocks.evaluate.mockResolvedValue({programming_operations:[{operation_id:operationId,operation_hash:input.operation_hash}]});mocks.persist.mockResolvedValue({ready:false});});
describe('operation programming preparation guards',()=>{
  it.each([
    [{...of,updated_at:'changed'},'CONCURRENT_MODIFICATION'],
    [{...of,statut:'PLANIFIE'},'OF_PREPARATION_LOCKED'],
    [{...of,statut:'ANNULE'},'OF_PREPARATION_LOCKED'],
    [{...of,technical_snapshot_sha256:'frozen'},'PROGRAMMING_PREPARATION_FROZEN'],
  ])('refuses a locked or stale OF',async(order,code)=>{
    mocks.load.mockResolvedValue(order);
    await expect(repoPrepareOperationProgramming(7,input,audit)).rejects.toMatchObject({code});
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('refuses an operation outside the route',async()=>{
    mocks.evaluate.mockResolvedValue({programming_operations:[]});
    await expect(repoPrepareOperationProgramming(7,input,audit)).rejects.toMatchObject({code:'PROGRAMMING_OPERATION_INVALID'});
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('refuses a route edited since opening the dialog',async()=>{
    await expect(repoPrepareOperationProgramming(7,{...input,operation_hash:'b'.repeat(64)},audit)).rejects.toMatchObject({code:'PROGRAMMING_OPERATION_CHANGED'});
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('saves only the OF estimate and recalculates the dossier without declaring a CNC program done',async()=>{
    await repoPrepareOperationProgramming(7,input,audit);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [sql,params]=mocks.query.mock.calls[0];
    expect(sql).toContain('operation_programming');expect(sql).not.toContain('piece_version_programming_tasks');
    expect(JSON.parse(params[3])).toMatchObject({estimated_hours:1.5,version_id:of.version_id,prepared_by:7});
    expect(mocks.persist).toHaveBeenCalledWith(expect.anything(),7);
  });
});
describe('programming progress on a frozen dossier',()=>{
  const task={id:operationId,updated_at:'task-v1',status:'TODO',assignee_id:2,estimated_hours:'4',program_reference:'CN-001',progress_percent:0};
  const progressInput={expected_updated_at:of.updated_at,expected_task_updated_at:task.updated_at,assignee_id:2,estimated_hours:4,status:'TODO' as const,progress_percent:25};
  beforeEach(()=>{
    mocks.load.mockResolvedValue({...of,statut:'PLANIFIE',technical_snapshot_sha256:'frozen',technical_snapshot:{preparation_decisions:{programming:{mode:'TASK',task_id:operationId,estimated_hours:4}}}});
    mocks.query.mockImplementation(async(sql:string)=>({rows:sql.includes('SELECT id::text,updated_at::text,status')?[task]:sql.includes('SELECT u.id')?[{id:2}]:sql.includes('INSERT INTO public.piece_version_programming_tasks')?[{id:operationId}]:[]}));
  });
  it('enregistre le palier sans invalider la définition ni engager de créneau',async()=>{
    await repoSaveProgrammingTask(7,progressInput,audit);
    const writes=mocks.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO public.piece_version_programming_tasks'));
    expect(writes).toHaveLength(1);expect(writes[0][1][7]).toBe(25);
    expect(mocks.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO public.piece_version_preparation')||sql.includes('planning_events'))).toBe(false);
    expect(mocks.persist).toHaveBeenCalledWith(expect.anything(),7);
  });
  it('refuse un palier si la tâche a été modifiée entretemps',async()=>{
    await expect(repoSaveProgrammingTask(7,{...progressInput,expected_task_updated_at:'stale'},audit)).rejects.toMatchObject({code:'CONCURRENT_MODIFICATION'});
    expect(mocks.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO'))).toBe(false);
  });
  it('refuse de changer le responsable sous couvert de progression',async()=>{
    await expect(repoSaveProgrammingTask(7,{...progressInput,assignee_id:3},audit)).rejects.toMatchObject({code:'PROGRAMMING_DEFINITION_FROZEN'});
    expect(mocks.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO'))).toBe(false);
  });
});
