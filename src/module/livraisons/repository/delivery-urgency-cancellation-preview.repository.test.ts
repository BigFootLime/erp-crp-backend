import { describe,expect,it,vi } from 'vitest';
const restitution = vi.hoisted(() => ({ read: vi.fn(async () => ({ evidence: { quantity: '10' }, response: { can_restore: true, issues: [] } })) }));
vi.mock('./urgency-restitution-preview.repository', () => ({ readUrgencyRestitutionTx: restitution.read }));
import { readUrgencyCancellationTx,type CancellationOf } from './delivery-urgency-cancellation-preview.repository';
const draft=():CancellationOf=>({id:10,numero:'OF-10',statut:'BROUILLON',technical_snapshot_sha256:null,updated_at:'2026-10-12',
  operations:[],material_needs:[],reservations:[],component_uses:[],groupings:[],events:[]});
function tx(tree:CancellationOf[],status='WAITING_PLANNER') {return {query:vi.fn().mockImplementation(async(sql:string)=>({rows:
  sql.includes('SELECT request.id')?[{id:'r1',beneficiary_allocation_id:1,status,version:1,approved_id:status==='APPROVED'?'a1':null,
    withdrawn_id:status==='WITHDRAWN'?'w1':null,commande_id:1}]:sql.includes('SELECT recovery_of_id')?[{recovery_of_id:10}]:tree}))};}
describe('cancellation review independent of supply approval',()=>{
  it('allows a whole untouched tree to be cancelled',async()=>{
    expect((await readUrgencyCancellationTx(tx([draft()]),'r1')).response).toMatchObject({can_cancel:true,requires_planner:false,production_retained:false});
  });
  it.each(['operations','material_needs','reservations','component_uses','groupings','events'] as const)('protects %s as production engagements',async key=>{
    const of=draft();of[key]=[{id:'engagement'}];
    expect((await readUrgencyCancellationTx(tx([of]),'r1')).response).toMatchObject({can_cancel:true,requires_planner:true,production_retained:true});
  });
  it('requires the planner after approval, even if drafts are unchanged',async()=>{
    expect((await readUrgencyCancellationTx(tx([draft()],'APPROVED'),'r1')).response.requires_planner).toBe(true);
  });
  it('requires a planner-reviewed restitution after withdrawal',async()=>{
    const result=await readUrgencyCancellationTx(tx([draft()],'WITHDRAWN'),'r1');
    expect(result.response.can_cancel).toBe(true);expect(result.response.requires_planner).toBe(true);
    expect(result.response.restitution).toMatchObject({can_restore:true});
  });
  it('reports missing recovery roots instead of silently cancelling',async()=>{
    expect((await readUrgencyCancellationTx(tx([]),'r1')).response.issues[0].code).toBe('URGENCY_RECOVERY_MISSING');
  });
  it('invalidates review when an engagement changes',async()=>{
    const of=draft(),before=await readUrgencyCancellationTx(tx([of]),'r1');of.events=[{id:'slot',start:'2026-10-13'}];
    const after=await readUrgencyCancellationTx(tx([of]),'r1');expect(before.response.preview_hash).not.toBe(after.response.preview_hash);
  });
});
