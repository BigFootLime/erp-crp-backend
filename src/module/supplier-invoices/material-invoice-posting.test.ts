import { describe,it,expect } from 'vitest';
import { buildMaterialInvoicePosting } from './material-invoice-posting';
import type { MaterialLineProposal } from './material-invoice-reconciliation';
import type { CumpState } from '../stock/domain/cump-valuation';
import { materialInvoicePostingBody } from './material-invoice-posting.validators';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,sha='a'.repeat(64);
const state=(quantity='40.000000000000',value='400.000000000000'):CumpState=>({
 scope:{articleId:id(3),owner:'COMPANY',unit:'u',currency:'EUR'},quantity,value,reliability:'DECLARED',sourceRef:`stock-valuation-entry:${id(20)}`});
function line():MaterialLineProposal {
 return {invoice_line_id:id(1),position:1,order_line_id:id(2),calculable:true,projection_ready:true,source_reliability:'DECLARED',
 invoice_amount_ht:'1200',booked_amount_ht:'1000',variance_ht:'200',stock_variance_ht:'80',consumed_variance_ht:'120',issues:[],
 lots:[{lot_id:id(4),lot_code:'MP-1',article_id:id(3),unit:'u',received_quantity:'100',remaining_quantity:'40',consumed_quantity:'60',
 invoice_amount_ht:'1200',booked_amount_ht:'1000',variance_ht:'200',stock_variance_ht:'80',consumed_variance_ht:'120',receipt_refs:[],
 consumption_refs:[{movement_id:id(5),line_id:id(6),quantity:'20',of_id:'91',stock_sha256:sha},
 {movement_id:id(7),line_id:id(8),quantity:'40',of_id:null,stock_sha256:sha}]}]};
}
// Prepared for final combined financial/RBAC/concurrency acceptance; NOT RUN.
describe('explicit sourced material invoice posting',()=>{
 it('changes value only and keeps proved and unassigned consumed owners separate',()=>{
 const original=state(),p=buildMaterialInvoicePosting([line()],[{state:original,entry_id:id(21)}]);
 expect(p.adjustments[0]?.result.before).toEqual(original);
 expect(p.adjustments[0]?.result).toMatchObject({quantityDelta:'0',valueDelta:'80',after:{quantity:'40',value:'480',reliability:'DECLARED'}});
 expect(p.consumption).toMatchObject([{of_id:'91',amount_ht:'40'},{of_id:null,amount_ht:'80'}]);
 });
 it('retains signed discounts and their exact twelve-decimal residual',()=>{
 const l=line();Object.assign(l.lots[0]!,{variance_ht:'-0.000000000001',stock_variance_ht:'0',consumed_variance_ht:'-0.000000000001'});
 const p=buildMaterialInvoicePosting([l],[{state:state(),entry_id:id(21)}]);
 expect(p.consumption.map(r=>r.amount_ht)).toEqual(['0','-0.000000000001']);
 });
 it('accepts exhausted known stock without adding physical quantity',()=>{
 const l=line();Object.assign(l.lots[0]!,{remaining_quantity:'0',consumed_quantity:'100',stock_variance_ht:'0',consumed_variance_ht:'200'});
 l.lots[0]!.consumption_refs[1]!.quantity='80';
 const p=buildMaterialInvoicePosting([l],[{state:state('0','0'),entry_id:id(21)}]);
 expect(p.adjustments[0]?.result).toMatchObject({quantityDelta:'0',valueDelta:'0',after:{quantity:'0',value:'0'}});
 expect(p.consumption.map(r=>r.amount_ht)).toEqual(['40','160']);
 });
 it('refuses unknown/negative stock value, duplicate line attribution or an incomplete consumption total',()=>{
 const l=line();expect(()=>buildMaterialInvoicePosting([l],[{state:{...state(),value:null,reliability:'UNKNOWN'},entry_id:id(21)}])).toThrow();
 Object.assign(l.lots[0]!,{variance_ht:'-2000',stock_variance_ht:'-800',consumed_variance_ht:'-1200'});
 expect(()=>buildMaterialInvoicePosting([l],[{state:state(),entry_id:id(21)}])).toThrow();
 const duplicate=line();duplicate.lots[0]!.consumption_refs[1]!.line_id=id(6);
 expect(()=>buildMaterialInvoicePosting([duplicate],[{state:state(),entry_id:id(21)}])).toThrow();
 const incomplete=line();incomplete.lots[0]!.consumption_refs.pop();
 expect(()=>buildMaterialInvoicePosting([incomplete],[{state:state(),entry_id:id(21)}])).toThrow();
 });
 it('rejects HTTP amounts and normalizes only the request UUID',()=>{
 const intent={method:'INVOICE_LOT_REMAINING_V1',expected_source_sha256:sha,request_id:id(30).toUpperCase()};
 expect(materialInvoicePostingBody.parse(intent).request_id).toBe(id(30));
 expect(materialInvoicePostingBody.safeParse({...intent,amount_ht:'100'}).success).toBe(false);
 });
});
