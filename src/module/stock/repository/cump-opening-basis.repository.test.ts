// Prepared for the final common acceptance. Not executed during incremental deployment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { readDeclaredOpeningValueTx } from './cump-opening-basis.repository';
import { openingBasisBody,openingBasisParams } from '../validators/cump-opening-basis.validators';
import type { CumpOpening } from '../domain/cump-opening';

const article='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const opening:CumpOpening={openingIds:[id],state:{scope:{articleId:article,owner:'COMPANY',unit:'u',currency:'EUR'},
  quantity:'20',value:null,reliability:'UNKNOWN',sourceRef:null}};
const adapter=(rows:unknown[],calls:unknown[][]=[])=>( {query:async(_sql:string,params:unknown[])=>{
  calls.push(params);return {rows};}} as unknown as Pick<PoolClient,'query'>);

test('documented company base supplies its exact amount and immutable source reference',async()=>{
  const calls:unknown[][]=[];
  const value=await readDeclaredOpeningValueTx(adapter([{id,total_value_ht:'123.450000000001',
    source_sha256:'a'.repeat(64),source_valid:true}],calls),opening);
  assert.deepEqual(value,{value:'123.450000000001',proof:{opening_basis_id:id,opening_basis_sha256:'a'.repeat(64)}});
  assert.deepEqual(calls[0],[article,'COMPANY','u','EUR','20',JSON.stringify([id])]);
});
test('a failed opening proof supplies no invented amount',async()=>{
  const value=await readDeclaredOpeningValueTx(adapter([{id,total_value_ht:'123',source_sha256:'a'.repeat(64),
    source_valid:false}]),opening);
  assert.deepEqual(value,{value:null,proof:{issues:['OPENING_BASIS_PROOF_INVALID']}});
  assert.equal(await readDeclaredOpeningValueTx(adapter([]),opening),null);
});
test('client ownership, zero opening and other currencies never consult a company opening base',async()=>{
  const calls:unknown[][]=[];
  for(const state of [{...opening.state,quantity:'0'},
    {...opening.state,scope:{...opening.state.scope,owner:'CLIENT:ABC' as const}},
    {...opening.state,scope:{...opening.state.scope,currency:'USD'}}]){
    assert.equal(await readDeclaredOpeningValueTx(adapter([],calls),{...opening,state}),null);
  }
  assert.equal(calls.length,0);
});
test('strict approval input refuses arbitrary quantities, currency, aliases and excessive precision',()=>{
  const body={request_id:id,document_id:id,expected_source_sha256:'a'.repeat(64),expected_document_sha256:'b'.repeat(64),
    total_value_ht:'0.000000000001'};
  assert.equal(openingBasisBody.safeParse(body).success,true);
  for(const invalid of [{...body,quantity:'99'},{...body,currency:'USD'},{...body,total_value_ht:'1e8'},
    {...body,total_value_ht:'-1'},{...body,total_value_ht:'1.0000000000001'}]){
    assert.equal(openingBasisBody.safeParse(invalid).success,false);
  }
  assert.equal(openingBasisParams.safeParse({articleId:article,unit:'u'}).success,true);
  assert.equal(openingBasisParams.safeParse({articleId:article,unit:'PIÈCES'}).success,false);
});
test('database failure is propagated rather than converted into a valid zero value',async()=>{
  const tx={query:async()=>{throw new Error('database failure');}} as unknown as Pick<PoolClient,'query'>;
  await assert.rejects(readDeclaredOpeningValueTx(tx,opening),/database failure/);
});
