import { calculateMargin, MARGIN_FORMULA_VERSION, type MarginCalculationInput } from './margin-engine';
import { parseCumpDecimal as decimal, formatCumpDecimal as text } from '../../stock/domain/cump-decimal';

type ObjectValue=Record<string,unknown>;
const object=(value:unknown):ObjectValue|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as ObjectValue:null;
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export type ManufacturingBasisSource={source_snapshot:unknown;source_sha256:string};
export type ManufacturingBasisCandidate={
  of_id:string; margin_snapshot_id:string; source_sha256:string; eligible:boolean; issues:string[];
  quantity_good:string|null; total_cost_ht:string|null; currency:'EUR'; source_reliability:'DECLARED';
  piece_technique_id:string|null; piece_technique_version_id:string|null; margin_as_of:string|null;
};

/** Approval is a declaration of the selected saved basis, never promotion of
 * estimated margins to verified financial evidence. Revenue is not a cost. */
export function readManufacturingBasisCandidate(row:ManufacturingBasisSource,ofId:string,snapshotId:string):ManufacturingBasisCandidate {
  const source=object(row.source_snapshot),order=object(source?.of),margin=object(source?.margin);
  const result=object(margin?.result_snapshot),input=object(margin?.input_snapshot);
  const candidate:ManufacturingBasisCandidate={of_id:ofId,margin_snapshot_id:snapshotId,source_sha256:row.source_sha256,
    eligible:false,issues:[],quantity_good:null,total_cost_ht:null,currency:'EUR',source_reliability:'DECLARED',
    piece_technique_id:uuid(order?.piece_technique_id)?order.piece_technique_id:null,
    piece_technique_version_id:uuid(order?.piece_technique_version_id)?order.piece_technique_version_id:null,
    margin_as_of:typeof margin?.as_of==='string'?margin.as_of:null};
  const issue=(code:string)=>candidate.issues.push(code);
  if(!source||source.schema_version!==1||!order||order.id!==ofId||!/^[0-9a-f]{64}$/.test(row.source_sha256))
    issue('MANUFACTURING_BASIS_SOURCE_INVALID');
  if(!candidate.piece_technique_id||!candidate.piece_technique_version_id) issue('MANUFACTURING_TECHNICAL_VERSION_MISSING');
  if(order?.status==='ANNULE') issue('MANUFACTURING_ORDER_CANCELLED');
  if(source?.dense_operations||source?.dense_declarations||source?.margin_omitted) issue('MANUFACTURING_BASIS_EVIDENCE_DENSE');
  const operations=Array.isArray(source?.operations)?source.operations:[];
  if(operations.length===0||operations.some(op=>object(op)?.status!=='DONE')) issue('MANUFACTURING_OPERATIONS_NOT_CLOSED');
  if(!uuid(source?.good_operation_id)||!operations.some(op=>object(op)?.id===source?.good_operation_id))
    issue('MANUFACTURING_FINAL_OPERATION_MISSING');
  if(typeof source?.declaration_count!=='number'||!Number.isSafeInteger(source.declaration_count)||source.declaration_count<=0
    ||typeof source?.declaration_sha256!=='string'||!/^[0-9a-f]{64}$/.test(source.declaration_sha256))
    issue('MANUFACTURING_DECLARATION_PROOF_MISSING');
  if(!margin||margin.id!==snapshotId||margin.scope_type!=='OF'||margin.scope_ref!==ofId||margin.basis!=='ACTUAL'
    ||!result||!input||object(result.scope)?.type!=='OF'||object(result.scope)?.ref!==ofId
    ||result.basis!=='ACTUAL'||input.scope_type!=='OF'||input.scope_ref!==ofId||input.basis!=='ACTUAL')
    issue('MANUFACTURING_ACTUAL_COST_SNAPSHOT_MISSING');
  const snapshotTime=typeof margin?.created_at==='string'?Date.parse(margin.created_at):NaN;
  const orderTime=typeof order?.updated_at==='string'?Date.parse(order.updated_at):NaN;
  if(!Number.isFinite(snapshotTime)||!Number.isFinite(orderTime)||orderTime>snapshotTime||operations.some(op=>{
    const updated=object(op)?.updated_at;
    const time=typeof updated==='string'?Date.parse(updated):NaN;
    return !Number.isFinite(time)||time>snapshotTime;
  })) issue('MANUFACTURING_OPERATION_COST_SNAPSHOT_STALE');
  if(result?.currency!=='EUR'||result?.formula_version!==MARGIN_FORMULA_VERSION) issue('MANUFACTURING_COST_FORMULA_UNSUPPORTED');
  const measures=object(result?.measurements),inputMeasures=object(input?.measurements);
  if(measures?.good_quantity_scope!=='FINAL_ACTIVE_OPERATION_DECLARED'
    ||measures?.good_operation_id!==source?.good_operation_id
    ||measures?.good_declaration_count!==source?.declaration_count
    ||measures?.good_declaration_freshness!==source?.declaration_freshness)
    issue('MANUFACTURING_QUANTITY_SNAPSHOT_STALE');
  try {
    if(typeof source?.good_quantity!=='string'||decimal(source.good_quantity)<=0n
      ||typeof measures?.good_quantity!=='string'||decimal(measures.good_quantity)!==decimal(source.good_quantity)
      ||typeof inputMeasures?.good_quantity!=='string'||decimal(inputMeasures.good_quantity)!==decimal(source.good_quantity))
      issue('MANUFACTURING_GOOD_QUANTITY_INVALID');
    else candidate.quantity_good=text(decimal(source.good_quantity));
    if(typeof source?.pending_control_quantity!=='string'||decimal(source.pending_control_quantity,true)!==0n
      ||typeof source?.rework_quantity!=='string'||decimal(source.rework_quantity,true)!==0n)
      issue('MANUFACTURING_QUANTITY_AWAITING_CONTROL');
    if(typeof result?.cost_total_ht!=='string') issue('MANUFACTURING_TOTAL_COST_UNKNOWN');
    else {
      const cost=decimal(result.cost_total_ht);
      // Re-evaluate only immutable inputs, not current catalogue/stock prices.
      const recalculated=calculateMargin(input as unknown as MarginCalculationInput);
      if(recalculated.cost_total_ht===null||decimal(recalculated.cost_total_ht)!==cost
        ||recalculated.missing_inputs.some(entry=>entry.category!=='REVENUE')) issue('MANUFACTURING_TOTAL_COST_INCONSISTENT');
      else candidate.total_cost_ht=text(cost);
    }
  } catch { issue('MANUFACTURING_BASIS_NUMERIC_OR_COST_INPUT_INVALID'); }
  candidate.issues=[...new Set(candidate.issues)]; candidate.eligible=candidate.issues.length===0;
  return candidate;
}
