import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMargin, MARGIN_COST_CATEGORIES, type MarginCalculationInput, type MarginEvidence } from './margin-engine';
import { readManufacturingBasisCandidate, type ManufacturingBasisSource } from './manufacturing-cost-basis';
import { manufacturingBasisBody, manufacturingBasisParams } from '../validators/manufacturing-cost-basis.validators';

// Prepared for final combined acceptance. No financial declaration is executed.
const OP='00000000-0000-0000-0000-000000000001',PT='00000000-0000-0000-0000-000000000002';
const VERSION='00000000-0000-0000-0000-000000000003',SNAPSHOT='00000000-0000-0000-0000-000000000004';
const observed='2026-10-08 10:00:00+02';
function fixture():ManufacturingBasisSource {
  const proof:MarginEvidence={definition:'Saved declared cost',unit:'EUR',period_start:'2026-10-08',period_end:'2026-10-08',
    freshness_at:observed,source_reliability:'ESTIMATED',source_type:'OF_OPERATION',source_ref:OP,observed_at:observed,
    assumption:'Declared cost basis',assumption_date:'2026-10-08',rate_version_id:null,rate_id:null,rate_effective_at:null,
    rate_scope_type:null,rate_scope_ref:null,source_document_type:'OF',source_document_ref:'91'};
  const measurements={good_quantity:'3.0000',good_quantity_scope:'FINAL_ACTIVE_OPERATION_DECLARED',good_operation_id:OP,
    good_declaration_count:2,good_declaration_freshness:observed};
  const input:MarginCalculationInput={scope_type:'OF',scope_ref:'91',label:'OF 91',basis:'ACTUAL',as_of:'2026-10-08',
    revenue:null,measurements,costs:MARGIN_COST_CATEGORIES.map(category=>({key:category,category,
      availability:category==='MATERIAL'?'PROVIDED':'NOT_APPLICABLE',amount_ht:category==='MATERIAL'?'90':null,
      quantity:null,rate:null,rate_unit:null,currency:'EUR',evidence:proof}))};
  return {source_sha256:'a'.repeat(64),source_snapshot:{schema_version:1,
    of:{id:'91',piece_technique_id:PT,piece_technique_version_id:VERSION,status:'EN_COURS',updated_at:'2026-10-08T08:00:00Z'},
    operations:[{id:OP,status:'DONE',updated_at:'2026-10-08T08:00:00Z'}],good_operation_id:OP,
    good_quantity:'3',pending_control_quantity:'0',rework_quantity:'0',declaration_count:2,
    declaration_freshness:observed,declaration_sha256:'b'.repeat(64),dense_operations:false,dense_declarations:false,margin_omitted:false,
    margin:{id:SNAPSHOT,scope_type:'OF',scope_ref:'91',basis:'ACTUAL',as_of:'2026-10-08',created_at:'2026-10-08T08:01:00Z',
      input_snapshot:input,result_snapshot:calculateMargin(input)}}};
}
const read=(row:ManufacturingBasisSource)=>readManufacturingBasisCandidate(row,'91',SNAPSHOT);
test('saved cost remains a declared basis, independently of missing sales revenue',()=>{
  const candidate=read(fixture());assert.equal(candidate.eligible,true);
  assert.equal(candidate.total_cost_ht,'90');assert.equal(candidate.quantity_good,'3');assert.equal(candidate.source_reliability,'DECLARED');
});
test('wrong OF, technical version, saved scope or altered cost cannot form a basis',()=>{
  for(const mutate of [
    (s:any)=>s.of.id='92',(s:any)=>s.of.piece_technique_version_id=null,
    (s:any)=>s.margin.scope_ref='92',(s:any)=>s.margin.result_snapshot.cost_total_ht='100',
    (s:any)=>s.margin.result_snapshot.currency='USD',(s:any)=>s.margin.input_snapshot.basis='STANDARD',
  ]){const row=fixture();mutate(row.source_snapshot);assert.equal(read(row).eligible,false);}
});
test('open operations, control, rework, new quantities and stale time facts require preparation',()=>{
  for(const mutate of [
    (s:any)=>s.operations[0].status='RUNNING',(s:any)=>s.pending_control_quantity='1',
    (s:any)=>s.rework_quantity='1',(s:any)=>s.good_quantity='4',
    (s:any)=>s.declaration_count=3,(s:any)=>s.operations[0].updated_at='2026-10-08T09:00:00Z',
  ]){const row=fixture();mutate(row.source_snapshot);assert.equal(read(row).eligible,false);}
});
test('truncated evidence and unknown costs stay unavailable rather than a zero estimate',()=>{
  for(const mutate of [
    (s:any)=>s.dense_operations=true,(s:any)=>s.dense_declarations=true,
    (s:any)=>s.margin_omitted=true,(s:any)=>s.margin.result_snapshot.cost_total_ht=null,
    (s:any)=>s.margin.input_snapshot.costs[0].amount_ht=null,
  ]){const row=fixture();mutate(row.source_snapshot);assert.equal(read(row).eligible,false);}
});
test('validation accepts only references and freshness proof, never a free cost or quantity',()=>{
  const body={request_id:SNAPSHOT,margin_snapshot_id:SNAPSHOT,expected_source_sha256:'a'.repeat(64)};
  assert.equal(manufacturingBasisBody.safeParse(body).success,true);
  assert.equal(manufacturingBasisBody.safeParse({...body,total_cost_ht:'123'}).success,false);
  for(const ofId of ['0','-1','00091','9223372036854775808','1e2'])
    assert.equal(manufacturingBasisParams.safeParse({ofId}).success,false);
});
