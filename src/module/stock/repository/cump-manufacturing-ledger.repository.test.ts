import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import type { CumpJournalSource } from '../domain/cump-posting-source';
import type { CumpScope } from '../domain/cump-valuation';
import type { ManufacturingReceiptProof } from '../domain/cump-manufacturing-source';
import { resolveCumpManufacturingReceiptTx, resolveCumpManufacturingLinkedReturnTx } from './cump-manufacturing-ledger.repository';
import * as returns from './cump-return-ledger.repository';
import * as sql from './cump-manufacturing-ledger.sql';

// Prepared, NOT RUN. Transaction/constraint behavior still requires the final
// combined PostgreSQL recipe; this adapter fixture does not prove DB rollback.
const ARTICLE='00000000-0000-0000-0000-000000000001',MOVEMENT='00000000-0000-0000-0000-000000000002';
const ENTRY='00000000-0000-0000-0000-000000000003',BASIS='00000000-0000-0000-0000-000000000004';
const PT='00000000-0000-0000-0000-000000000005',VERSION='00000000-0000-0000-0000-000000000006';
const SNAPSHOT='00000000-0000-0000-0000-000000000007',RECEIPT='00000000-0000-0000-0000-000000000008';
const ORIGINAL='00000000-0000-0000-0000-000000000009';
const scope:CumpScope={articleId:ARTICLE,owner:'COMPANY',unit:'u',currency:'EUR'};
function source():CumpJournalSource {
  return {sequence:'10',movement_id:MOVEMENT,article_id:ARTICLE,source_sha256:'a'.repeat(64),source_valid:true,
    source_snapshot:{reversal_of_id:null},acquisition_snapshot:null,acquisition_sha256:null,acquisition_valid:null};
}
const physical=(quantity='1'):ManufacturingReceiptProof=>({detected:true,issues:['MANUFACTURING_VALUE_ALLOCATION_REQUIRED'],
  proof:{of_id:'91',receipt_id:RECEIPT,piece_technique_id:PT,piece_technique_version_id:VERSION,
    quantity_good:quantity,manufacturing_source_sha256:'b'.repeat(64)}});
function fixture(overrides:{basisMissing?:boolean;cursorInvalid?:boolean;inverseInvalid?:boolean;queryFailure?:boolean;inverse?:boolean}={}) {
  const calls:Array<{query:string;params:unknown[]}>=[];
  const basis={id:BASIS,of_id:'91',margin_snapshot_id:SNAPSHOT,quantity_good:'3',total_cost_ht:'1',currency:'EUR',
    source_reliability:'DECLARED',source_sha256:'c'.repeat(64),source_valid:true,
    source_snapshot:{good_quantity:'3',of:{id:'91',article_id:ARTICLE,piece_technique_id:PT,piece_technique_version_id:VERSION},
      margin:{id:SNAPSHOT,scope_type:'OF',scope_ref:'91',basis:'ACTUAL',result_snapshot:{cost_total_ht:'1'}}}};
  const tx={query:async(query:string,params:unknown[]=[])=>{
    calls.push({query,params});
    if(overrides.queryFailure&&query===sql.CUMP_MANUFACTURING_BASIS_OF_SQL) throw new Error('database unavailable');
    if([sql.CUMP_MANUFACTURING_BASIS_OF_SQL,sql.CUMP_MANUFACTURING_BASIS_ID_SQL].includes(query))
      return {rows:overrides.basisMissing?[]:[basis]};
    if(query===sql.CUMP_MANUFACTURING_CURSOR_SQL) return {rows:overrides.cursorInvalid||overrides.inverse?[{
      article_id:ARTICLE,owner_key:'COMPANY',stock_unit:'u',currency:'EUR',quantity:'2',value:'0.666666666667',
      latest_event_id:ENTRY,source_valid:!overrides.cursorInvalid}]:[]};
    if(query===sql.CUMP_MANUFACTURING_PARENT_SQL) return {rows:[{id:RECEIPT,basis_id:BASIS,article_id:ARTICLE,
      owner_key:'COMPANY',stock_unit:'u',currency:'EUR',quantity_delta:'1',value_delta:'0.333333333333',source_valid:true}]};
    if(query===sql.CUMP_MANUFACTURING_INSERT_EVENT_SQL) return {rows:[{id:params[0]}]};
    if(query===sql.CUMP_MANUFACTURING_STORE_CURSOR_SQL) return {rows:[{basis_id:BASIS}]};
    if(query===sql.CUMP_MANUFACTURING_INVERSE_BOUNDS_SQL) return {rows:[{valid:!overrides.inverseInvalid}]};
    return {rows:[]};
  }} as unknown as Pick<PoolClient,'query'>;
  return {tx,calls};
}
test('proved receipt allocates its declared remaining cost and links one event to the new CUMP entry',async()=>{
  const f=fixture(),result=await resolveCumpManufacturingReceiptTx(f.tx,source(),physical(),scope,'1',ENTRY);
  assert.equal(result.cost.amount,'0.333333333333');assert.equal(result.cost.reliability,'DECLARED');
  assert.equal(result.proof.manufacturing_basis_id,BASIS);assert.equal(result.proof.manufacturing_value_allocation_required,false);
  const event=f.calls.find(c=>c.query===sql.CUMP_MANUFACTURING_INSERT_EVENT_SQL)!;
  assert.equal(event.params[2],ENTRY);assert.equal(event.params[10],'1');assert.equal(event.params[11],'0.333333333333');
  assert.equal(f.calls.filter(c=>c.query===sql.CUMP_MANUFACTURING_INSERT_EVENT_SQL).length,1);
});
test('missing, changed or invalid monetary evidence stays unknown without any allocation write',async()=>{
  for(const options of [{basisMissing:true},{cursorInvalid:true}]){
    const f=fixture(options),result=await resolveCumpManufacturingReceiptTx(f.tx,source(),physical(),scope,'1',ENTRY);
    assert.equal(result.cost.amount,null);assert.equal(f.calls.some(c=>c.query===sql.CUMP_MANUFACTURING_INSERT_EVENT_SQL),false);
    assert.equal(f.calls.some(c=>c.query==='ROLLBACK TO SAVEPOINT cump_manufacturing_receipt'),true);
  }
  const f=fixture(),p=physical();p.proof.piece_technique_version_id=PT;
  assert.equal((await resolveCumpManufacturingReceiptTx(f.tx,source(),p,scope,'1',ENTRY)).cost.amount,null);
  assert.equal(f.calls.some(c=>c.query===sql.CUMP_MANUFACTURING_INSERT_EVENT_SQL),false);
});
test('excess quantities and client-owned stock never consume the company manufacturing budget',async()=>{
  for(const [p,s,q] of [[physical('4'),scope,'4'],[physical(),{...scope,owner:'CLIENT:opaque-case'},'1']] as const){
    const f=fixture(),result=await resolveCumpManufacturingReceiptTx(f.tx,source(),p,s as CumpScope,q,ENTRY);
    assert.equal(result.cost.amount,null);assert.equal(f.calls.some(c=>c.query===sql.CUMP_MANUFACTURING_INSERT_EVENT_SQL),false);
  }
});
test('database errors abort the financial consumer rather than fabricating an unknown successful write',async()=>{
  const f=fixture({queryFailure:true});
  await assert.rejects(resolveCumpManufacturingReceiptTx(f.tx,source(),physical(),scope,'1',ENTRY),/database unavailable/);
});
test('receipt cancellation restores the exact original allocation and retains return proof',async(t)=>{
  t.mock.method(returns,'resolveCumpLinkedReturnTx',async()=>({kind:'RECEIPT_REVERSAL',
    cost:{amount:'0.333333333333',reliability:'DECLARED',sourceRef:'original'},
    proof:{original_entry_id:ORIGINAL,return_allocation_event_ids:[RECEIPT]},issues:[]}));
  const f=fixture({inverse:true}),row=source();row.source_snapshot={reversal_of_id:ORIGINAL};
  const result=await resolveCumpManufacturingLinkedReturnTx(f.tx,row,ORIGINAL,scope,'1',ENTRY);
  assert.equal(result.cost.amount,'0.333333333333');assert.deepEqual(result.proof.return_allocation_event_ids,[RECEIPT]);
  const event=f.calls.find(c=>c.query===sql.CUMP_MANUFACTURING_INSERT_EVENT_SQL)!;
  assert.equal(event.params[9],RECEIPT);assert.equal(event.params[10],'-1');assert.equal(event.params[11],'-0.333333333333');
});
test('invalid inverse bounds request rollback of both allocation paths and publish no guessed amount',async(t)=>{
  t.mock.method(returns,'resolveCumpLinkedReturnTx',async()=>({kind:'RECEIPT_REVERSAL',
    cost:{amount:'0.333333333333',reliability:'DECLARED',sourceRef:'original'},proof:{original_entry_id:ORIGINAL},issues:[]}));
  const f=fixture({inverse:true,inverseInvalid:true}),row=source();row.source_snapshot={reversal_of_id:ORIGINAL};
  const result=await resolveCumpManufacturingLinkedReturnTx(f.tx,row,ORIGINAL,scope,'1',ENTRY);
  assert.equal(result.cost.amount,null);assert.deepEqual(result.proof.return_allocation_event_ids,[]);
  assert.equal(f.calls.some(c=>c.query==='ROLLBACK TO SAVEPOINT cump_manufacturing_return'),true);
});
