import {describe,expect,it,vi} from 'vitest';
vi.mock('../../../config/database',()=>({default:{}}));
vi.mock('../../../shared/realtime/realtime-outbox-transaction',()=>({withRealtimeOutboxTransaction:vi.fn()}));
vi.mock('./production-preparation.repository',()=>({evaluateOfPreparation:vi.fn(async()=>({warnings:[]})),preparationAudit:vi.fn()}));
import {readOfDossierTx,type DossierDb} from './of-dossier.repository';
import {dossierSourceHash,type DossierOperation} from '../domain/of-dossier';

const operation:DossierOperation={id:'ce6c2b45-bae0-4a47-9ae8-9c04f1eae7c9',phase:10,label:'Débit',status:'TODO',planned:false,setup:.1,unit:.01,base:1,coefficient:1,start:null,end:null,resource:null};
function fixture(input:{target?:string|null;internalDue?:string|null;customerDue?:string|null;installed?:boolean;error?:Error}={}) {
  const row={id:95,status:'BROUILLON',technical_readiness:'VALIDATED',technical_snapshot_sha256:'a'.repeat(64),piece_technique_version_id:'617c4223-0b6e-47e0-8ef5-620759e180de',quantite_lancee:20,updated_at:'2026-10-10T10:00:00Z',numero:'OF-TARGET-TEST',customer_due:input.customerDue??null,internal_due:input.internalDue??null,date_lancement_reelle:null,date_fin_reelle:null,preparation_rules_version:2};
  const sourceHash=dossierSourceHash({id:95,status:row.status,technicalReadiness:row.technical_readiness,technicalHash:row.technical_snapshot_sha256,revision:row.piece_technique_version_id,quantity:20,operations:[operation]});
  const validation={id:'ac1ce828-dc96-4c86-a6fb-8c5ab3fe5355',source_hash:sourceHash,decided_at:'2026-10-10T10:01:00Z',decided_by:1,invalidated_at:null,invalidation_reason:null};
  const query=vi.fn(async(sql:string,values?:unknown[])=>{
    if(sql.includes('SELECT o.id::bigint::int'))return {rows:[row]};
    if(sql.includes('SELECT p.id::text,p.phase'))return {rows:[operation]};
    if(sql.includes('FROM public.of_dossier_validations'))return {rows:[validation]};
    if(sql.includes('SELECT CASE WHEN count(*)'))return {rows:[{end:'2026-10-20T16:00:00Z',issues:[]}]};
    if(sql.includes("to_regclass('public.client_contract_replenishment_roots')"))return {rows:[{installed:input.installed??true}]};
    if(sql.startsWith('WITH requested AS')){
      expect(values).toEqual([[95]]);
      if(input.error)throw input.error;
      return {rows:input.target?[{of_id:'95',target_date:input.target}]:[]};
    }
    if(sql.includes('FROM public.planning_forecast_state'))return {rows:[{status:'READY',calculatedAt:'2026-10-10T10:02:00Z',sourceRevision:'1',issueCount:0,error:null}]};
    throw Error('Unexpected dossier SQL');
  });
  return {tx:{query} as unknown as DossierDb,query,sourceHash};
}
describe('OF dossier preserves anticipated original objectives',()=>{
  it('shows the overdue contract target without changing customer AR, COMPLETE or source hash',async()=>{
    const f=fixture({target:'2026-09-30'}),out=await readOfDossierTx(f.tx,95);
    expect(out.dates).toMatchObject({customerDue:null,internalDue:'2026-09-30',forecastEnd:'2026-10-20T16:00:00Z',actualStart:null,actualEnd:null});
    expect(out.status).toBe('COMPLETE');expect(out.sourceHash).toBe(f.sourceHash);
    expect(f.query.mock.calls.some(([sql])=>/\b(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
  });
  it.each([['2026-09-15','2026-09-15'],['2026-10-31','2026-09-30']])('keeps the earliest explicit internal objective (%s)',async(internalDue,expected)=>{
    const f=fixture({target:'2026-09-30',internalDue,customerDue:'2026-11-10'}),out=await readOfDossierTx(f.tx,95);
    expect(out.dates.internalDue).toBe(expected);expect(out.dates.customerDue).toBe('2026-11-10');
  });
  it('keeps ordinary firm/internal dossiers unchanged when no target is owned',async()=>{
    const f=fixture({internalDue:'2026-10-30',customerDue:'2026-11-02'}),out=await readOfDossierTx(f.tx,95);
    expect(out.dates).toMatchObject({internalDue:'2026-10-30',customerDue:'2026-11-02'});
    expect(out.status).toBe('COMPLETE');expect(out.sourceHash).toBe(f.sourceHash);
  });
  it('keeps a pre-migration dossier readable without querying absent roots',async()=>{
    const f=fixture({installed:false}),out=await readOfDossierTx(f.tx,95);
    expect(out.dates.internalDue).toBeNull();expect(f.query.mock.calls.some(([sql])=>sql.startsWith('WITH requested AS'))).toBe(false);
  });
  it('propagates a target read failure instead of reporting an invented empty objective',async()=>{
    const error=new Error('Target snapshot unavailable'),f=fixture({target:'2026-09-30',error});
    await expect(readOfDossierTx(f.tx,95)).rejects.toBe(error);
  });
});
