import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseCumpDecimal as decimal, formatCumpDecimal as text } from '../domain/cump-decimal';
import { allocateManufacturingCost, reverseManufacturingCost, restoreManufacturingCost,
  type ManufacturingCostBudget, type ManufacturingCostAllocation } from '../domain/manufacturing-cost-allocation';
import type { ManufacturingReceiptProof } from '../domain/cump-manufacturing-source';
import type { CumpJournalSource } from '../domain/cump-posting-source';
import type { CumpCostEvidence, CumpScope } from '../domain/cump-valuation';
import { resolveCumpLinkedReturnTx } from './cump-return-ledger.repository';
import * as sql from './cump-manufacturing-ledger.sql';

type Tx=Pick<PoolClient,'query'>;
type Basis={id:string;of_id:string;margin_snapshot_id:string;quantity_good:string;total_cost_ht:string;
  currency:string;source_reliability:string;source_snapshot:unknown;source_sha256:string;source_valid:boolean};
type Cursor={article_id:string;owner_key:string;stock_unit:string;currency:string;quantity:string;value:string;
  latest_event_id:string;source_valid:boolean};
type Parent={id:string;basis_id:string;article_id:string;owner_key:string;stock_unit:string;currency:string;
  quantity_delta:string;value_delta:string;source_valid:boolean};
type Resolution={cost:CumpCostEvidence;proof:Record<string,unknown>;issues:string[]};
const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const absolute=(value:bigint)=>value<0n?-value:value;
const expected=(error:unknown):error is Error=>error instanceof Error&&/^(CUMP_MANUFACTURING_|MANUFACTURING_COST_|CUMP_DECIMAL_|CUMP_RATIO_)/.test(error.message);
const unknown=(code:string,proof:Record<string,unknown>={}):Resolution=>({
  cost:{amount:null,reliability:'UNKNOWN',sourceRef:null},proof,issues:[code]});
const sameScope=(row:Cursor|Parent,scope:CumpScope)=>row.article_id===scope.articleId&&row.owner_key===scope.owner
  &&row.stock_unit===scope.unit&&row.currency===scope.currency;

function basisOrder(basis:Basis) {
  const source=object(basis.source_snapshot),order=object(source?.of),margin=object(source?.margin);
  if(!basis.source_valid||basis.source_reliability!=='DECLARED'||basis.currency!=='EUR'||!order
    ||order.id!==basis.of_id||margin?.id!==basis.margin_snapshot_id||margin.scope_type!=='OF'
    ||margin.scope_ref!==basis.of_id||margin.basis!=='ACTUAL'||decimal(basis.quantity_good)<=0n
    ||typeof source?.good_quantity!=='string'||decimal(source.good_quantity)!==decimal(basis.quantity_good)
    ||typeof object(margin.result_snapshot)?.cost_total_ht!=='string'
    ||decimal(object(margin.result_snapshot)!.cost_total_ht as string)!==decimal(basis.total_cost_ht))
    throw new Error('CUMP_MANUFACTURING_BASIS_PROOF_INVALID');
  return order;
}
async function readBudget(tx:Tx,basis:Basis,scope:CumpScope) {
  const cursor=(await tx.query<Cursor>(sql.CUMP_MANUFACTURING_CURSOR_SQL,[basis.id])).rows[0];
  if(cursor&&(!cursor.source_valid||!cursor.latest_event_id||!sameScope(cursor,scope)))
    throw new Error('CUMP_MANUFACTURING_CURSOR_PROOF_INVALID');
  return {budget:{quantity:basis.quantity_good,value:basis.total_cost_ht,allocatedQuantity:cursor?.quantity??'0',
    allocatedValue:cursor?.value??'0'} satisfies ManufacturingCostBudget,previousEventId:cursor?.latest_event_id??null};
}
async function storeAllocation(tx:Tx,row:CumpJournalSource,basis:Basis,scope:CumpScope,entryId:string,
  allocation:ManufacturingCostAllocation,previousEventId:string|null,inverse:Parent|null,
  proof:Record<string,unknown>):Promise<Record<string,unknown>> {
  const eventId=randomUUID(),sign=inverse&&decimal(inverse.quantity_delta,true)>0n?-1n:1n;
  const snapshot={...proof,schema_version:1,stock_source_sha256:row.source_sha256,basis_source_sha256:basis.source_sha256,
    before_budget:allocation.before,after_budget:allocation.after};
  const inserted=await tx.query(sql.CUMP_MANUFACTURING_INSERT_EVENT_SQL,[eventId,basis.id,entryId,row.movement_id,
    scope.articleId,scope.owner,scope.unit,scope.currency,previousEventId,inverse?.id??null,
    text(sign*decimal(allocation.quantity)),text(sign*decimal(allocation.value)),JSON.stringify(snapshot)]);
  if(inserted.rows.length!==1) throw new Error('CUMP_MANUFACTURING_EVENT_NOT_STORED');
  const updated=await tx.query(sql.CUMP_MANUFACTURING_STORE_CURSOR_SQL,[basis.id,scope.articleId,scope.owner,scope.unit,
    scope.currency,allocation.after.allocatedQuantity,allocation.after.allocatedValue,eventId]);
  if(updated.rows.length!==1) throw new Error('CUMP_MANUFACTURING_CURSOR_NOT_STORED');
  if(inverse&&(await tx.query<{valid:boolean}>(sql.CUMP_MANUFACTURING_INVERSE_BOUNDS_SQL,[inverse.id])).rows[0]?.valid!==true)
    throw new Error('CUMP_MANUFACTURING_INVERSE_BOUNDS_INVALID');
  return {...proof,manufacturing_basis_id:basis.id,manufacturing_basis_source_sha256:basis.source_sha256,
    manufacturing_allocation_event_id:eventId,manufacturing_allocation_before:allocation.before,
    manufacturing_allocation_after:allocation.after,manufacturing_value_allocation_required:false};
}

/** Called once for the frozen single-owner receipt, in the CUMP posting savepoint.
 * Invalid monetary evidence produces no partial allocation/cursor mutation. */
export async function resolveCumpManufacturingReceiptTx(tx:Tx,row:CumpJournalSource,receipt:ManufacturingReceiptProof,
  scope:CumpScope,quantity:string,entryId:string):Promise<Resolution> {
  if(scope.owner!=='COMPANY') return unknown('CLIENT_OWNED_STOCK_EXCLUDED_FROM_COMPANY_VALUE',receipt.proof);
  if(scope.unit!=='u'||scope.currency!=='EUR') return unknown('CUMP_MANUFACTURING_SCOPE_UNSUPPORTED',receipt.proof);
  await tx.query('SAVEPOINT cump_manufacturing_receipt');
  try {
    const proof=receipt.proof;
    if(!proof.of_id||!proof.receipt_id||!proof.piece_technique_id||!proof.piece_technique_version_id
      ||!proof.quantity_good||decimal(proof.quantity_good)!==decimal(quantity))
      throw new Error('CUMP_MANUFACTURING_RECEIPT_PROOF_MISSING');
    const basis=(await tx.query<Basis>(sql.CUMP_MANUFACTURING_BASIS_OF_SQL,[proof.of_id])).rows[0];
    if(!basis) throw new Error('CUMP_MANUFACTURING_COST_BASIS_MISSING');
    const order=basisOrder(basis);
    if(order.piece_technique_id!==proof.piece_technique_id||order.piece_technique_version_id!==proof.piece_technique_version_id
      ||(order.article_id!==null&&order.article_id!==scope.articleId))
      throw new Error('CUMP_MANUFACTURING_TECHNICAL_VERSION_MISMATCH');
    const current=await readBudget(tx,basis,scope),allocation=allocateManufacturingCost(current.budget,quantity);
    const saved=await storeAllocation(tx,row,basis,scope,entryId,allocation,current.previousEventId,null,{...proof});
    await tx.query('RELEASE SAVEPOINT cump_manufacturing_receipt');
    return {cost:{amount:allocation.value,reliability:'DECLARED',sourceRef:`manufacturing-cost-basis:${basis.id}`},proof:saved,
      issues:(receipt.issues??[]).filter(code=>!['MANUFACTURING_VALUE_ALLOCATION_REQUIRED',
        'MANUFACTURING_ACTUAL_MARGIN_SOURCE_MISSING','MANUFACTURING_COST_BASIS_NOT_VERIFIED'].includes(code))};
  } catch(error) {
    if(!expected(error)) throw error;
    await tx.query('ROLLBACK TO SAVEPOINT cump_manufacturing_receipt');await tx.query('RELEASE SAVEPOINT cump_manufacturing_receipt');
    return unknown(error.message,receipt.proof);
  }
}

/** Existing return allocation supplies the exact original amount. Manufacturing
 * budget changes are committed with it, or both are rolled back to unknown. */
export async function resolveCumpManufacturingLinkedReturnTx(tx:Tx,row:CumpJournalSource,originalMovementId:string,
  scope:CumpScope,quantity:string,entryId:string) {
  await tx.query('SAVEPOINT cump_manufacturing_return');
  let resolved:Awaited<ReturnType<typeof resolveCumpLinkedReturnTx>>|undefined;
  try {
    resolved=await resolveCumpLinkedReturnTx(tx,row,originalMovementId,scope,quantity,entryId);
    const originalEntryId=resolved.proof.original_entry_id;
    const parents=typeof originalEntryId==='string'
      ?(await tx.query<Parent>(sql.CUMP_MANUFACTURING_PARENT_SQL,[originalEntryId])).rows:[];
    if(parents.length===0) {await tx.query('RELEASE SAVEPOINT cump_manufacturing_return');return resolved;}
    const parent=parents[0];
    if(parents.length!==1||!parent.source_valid||!sameScope(parent,scope)||resolved.cost.amount===null
      ||scope.owner!=='COMPANY'||scope.unit!=='u'||scope.currency!=='EUR')
      throw new Error('CUMP_MANUFACTURING_INVERSE_PROOF_INVALID');
    if(decimal(quantity)>absolute(decimal(parent.quantity_delta,true))) throw new Error('CUMP_MANUFACTURING_INVERSE_QUANTITY_EXCEEDED');
    const basis=(await tx.query<Basis>(sql.CUMP_MANUFACTURING_BASIS_ID_SQL,[parent.basis_id])).rows[0];
    if(!basis) throw new Error('CUMP_MANUFACTURING_COST_BASIS_MISSING');basisOrder(basis);
    const root=object(row.source_snapshot);
    if(root?.reversal_of_id!==originalMovementId) throw new Error('CUMP_MANUFACTURING_INVERSE_LINK_MISSING');
    const current=await readBudget(tx,basis,scope),part={quantity,value:resolved.cost.amount};
    const allocation=decimal(parent.quantity_delta,true)>0n?reverseManufacturingCost(current.budget,part):restoreManufacturingCost(current.budget,part);
    const proof=await storeAllocation(tx,row,basis,scope,entryId,allocation,current.previousEventId,parent,resolved.proof);
    await tx.query('RELEASE SAVEPOINT cump_manufacturing_return');
    return {...resolved,cost:{amount:allocation.value,reliability:'DECLARED' as const,sourceRef:`manufacturing-cost-basis:${basis.id}`},proof};
  } catch(error) {
    if(!expected(error)||!resolved) throw error;
    await tx.query('ROLLBACK TO SAVEPOINT cump_manufacturing_return');await tx.query('RELEASE SAVEPOINT cump_manufacturing_return');
    return {kind:resolved.kind,cost:{amount:null,reliability:'UNKNOWN' as const,sourceRef:`stock-movement:${originalMovementId}`},
      proof:{original_movement_id:originalMovementId,original_entry_id:null,return_allocation_event_ids:[]},
      issues:[...resolved.issues,error.message]};
  }
}
