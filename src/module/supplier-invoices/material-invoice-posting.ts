import { parseCumpDecimal as decimal,formatCumpDecimal as text,roundCumpRatio as ratio } from '../stock/domain/cump-decimal';
import { CUMP_FORMULA_VERSION,normalizeCumpScope,type CumpState,type CumpTransitionResult } from '../stock/domain/cump-valuation';
import type { MaterialLineProposal,MaterialConsumptionRef } from './material-invoice-reconciliation';

export const MATERIAL_INVOICE_POSTING_FORMULA='CERP-CUMP-INVOICE-1.0.0' as const;
export type MaterialConsumedAllocation=MaterialConsumptionRef&{invoice_line_id:string;lot_id:string;amount_ht:string};
export type MaterialScopeAdjustment={article_id:string;unit:string;stock_variance_ht:string;consumed_variance_ht:string;
  entry_id:string;result:CumpTransitionResult};
const signedRatio=(n:bigint,d:bigint)=>n<0n?-ratio(-n,d):ratio(n,d);
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);

/** Service-owned proof inputs only. No HTTP amount or stale price is accepted.
 * One transition extends each article/company/unit balance, including empty
 * stock; consumed residuals are allocated against actual immutable issues. */
export function buildMaterialInvoicePosting(lines:MaterialLineProposal[],states:Array<{state:CumpState;entry_id:string}>) {
  if(!lines.length||lines.some(l=>!l.calculable||!l.projection_ready))throw Error('MATERIAL_PROPOSAL_NOT_READY');
  const grouped=new Map<string,{article_id:string;unit:string;stock:bigint;consumed:bigint}>();
  const consumption:MaterialConsumedAllocation[]=[];
  for(const line of lines)for(const lot of line.lots) {
    const key=`${lot.article_id}:${lot.unit}`,group=grouped.get(key)??{article_id:lot.article_id,unit:lot.unit,stock:0n,consumed:0n};
    const stock=decimal(lot.stock_variance_ht,true),consumed=decimal(lot.consumed_variance_ht,true);
    if(stock+consumed!==decimal(lot.variance_ht,true))throw Error('MATERIAL_VARIANCE_RESIDUAL_INVALID');
    group.stock+=stock;group.consumed+=consumed;grouped.set(key,group);
    const refs=[...lot.consumption_refs].sort((a,b)=>a.movement_id.localeCompare(b.movement_id)||a.line_id.localeCompare(b.line_id));
    const total=decimal(lot.consumed_quantity);
    if(refs.reduce((sum,r)=>sum+decimal(r.quantity),0n)!==total||new Set(refs.map(r=>r.line_id)).size!==refs.length
      ||total===0n&&consumed!==0n)throw Error('MATERIAL_CONSUMPTION_ATTRIBUTION_INVALID');
    let before=0n;
    for(const ref of refs) {
      const qty=decimal(ref.quantity);if(qty<=0n)throw Error('MATERIAL_CONSUMPTION_QUANTITY_INVALID');
      const delta=signedRatio(consumed*(before+qty),total)-signedRatio(consumed*before,total);before+=qty;
      consumption.push({...ref,invoice_line_id:line.invoice_line_id,lot_id:lot.lot_id,amount_ht:text(delta)});
    }
  }
  if(new Set(consumption.map(c=>c.line_id)).size!==consumption.length)throw Error('MATERIAL_CONSUMPTION_ATTRIBUTION_DUPLICATED');
  if(states.length!==grouped.size||new Set(states.map(s=>`${s.state.scope.articleId}:${s.state.scope.unit}`)).size!==states.length)
    throw Error('MATERIAL_POSTING_BALANCE_SCOPE_INVALID');
  const adjustments:MaterialScopeAdjustment[]=[];
  for(const group of [...grouped.values()].sort((a,b)=>a.article_id.localeCompare(b.article_id)||a.unit.localeCompare(b.unit))) {
    const row=states.find(s=>s.state.scope.articleId===group.article_id&&s.state.scope.unit===group.unit);
    if(!row)throw Error('MATERIAL_POSTING_BALANCE_MISSING');
    const scope=normalizeCumpScope(row.state.scope),quantity=decimal(row.state.quantity),value=row.state.value===null?null:decimal(row.state.value);
    if(!same(scope,{articleId:group.article_id,owner:'COMPANY',unit:group.unit,currency:'EUR'})||value===null
      ||!['DECLARED','VERIFIED'].includes(row.state.reliability)||!row.state.sourceRef?.trim()
      ||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.entry_id))throw Error('MATERIAL_POSTING_BALANCE_UNRESOLVED');
    const next=value+group.stock;
    if(next<0n||quantity===0n&&next!==0n)throw Error('MATERIAL_POSTING_VALUE_INVALID');
    // Preserve the exact prior state's decimal representation in its proof.
    const before={...row.state,scope};
    const after:CumpState={scope,quantity:text(quantity),value:text(next),reliability:'DECLARED',sourceRef:`stock-valuation-entry:${row.entry_id}`};
    const result:CumpTransitionResult={formulaVersion:CUMP_FORMULA_VERSION,before,after,quantityDelta:'0',valueDelta:text(group.stock),
      movementValue:text(group.stock<0n?-group.stock:group.stock),unitCost:null,movementReliability:'DECLARED',issues:[]};
    // Retain the numeric(38,12) domain on sums and transitions.
    for(const amount of [result.valueDelta,result.movementValue,result.after.value,text(group.consumed)])decimal(amount!,true);
    adjustments.push({article_id:group.article_id,unit:group.unit,stock_variance_ht:text(group.stock),
      consumed_variance_ht:text(group.consumed),entry_id:row.entry_id,result});
  }
  return {formula:MATERIAL_INVOICE_POSTING_FORMULA,adjustments,consumption};
}
