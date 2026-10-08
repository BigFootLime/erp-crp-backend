import { describe,it,expect } from 'vitest';
import { proposeMaterialInvoiceReconciliation,type MaterialReconciliationSources,type MaterialTrace } from './material-invoice-reconciliation';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,sha='a'.repeat(64);
function trace(n:number,type:string,quantity:string):MaterialTrace {
  return {movement_id:id(n),article_id:id(3),sequence:String(n),source_sha256:sha,source_valid:true,proof_complete:true,
    source_snapshot:{schema_version:1,movement_id:id(n),article_id:id(3),movement_type:type,quantity,stock_unit:'u',
      stock_batch_id:null,batch_owner_client_id:null,reversal_of_id:null,document_type:null,document_id:null,
      lines:[{line_id:id(n+100),line_no:1,article_id:id(3),lot_id:id(4),quantity,unit:'u',owner_client_id:null}]}};
}
function source():MaterialReconciliationSources {
  const incoming=trace(10,'IN','100'),acquisition={schema_version:1,movement_id:id(10),article_id:id(3),
    stock_quantity:'100',stock_unit:'u',owner_client_id:null,stock_source_sha256:sha,stock_lines:(incoming.source_snapshot as {lines:unknown}).lines,
    source_document_id:id(30),portions:[],receipts:[{receipt_stock_id:id(20),reception_id:id(30),line_reception_id:id(30),
      receipt_line_id:id(21),receipt_quantity:'100',stock_article_id:id(3),receipt_unit:'u',stock_unit:'u',conversion_coefficient:'1',
      receipt_order_id:id(6),receipt_supplier_id:id(7),order:{id:id(6),line_id:id(5),article_id:id(3),supplier_id:id(7),
        unit:'u',currency:'EUR',status:'CONFIRMEE',line_status:'ACTIVE'}}]};
  return {complete:true,invoice:{id:id(1),row_version:3,supplier_id:id(7),currency:'EUR',document_type:'INVOICE',
    match_id:id(8),order_id:id(6),approved:true,approval_id:id(9),header_allocation:null,header_facts:{invoice_id:id(1),currency:'EUR',
      document_type:'INVOICE',total_ht:'1200.00',match_version_id:id(8),match_purchase_order_id:id(6),match_outcome:'MATCHED',supplier_matches:true,
      lines:[{id:id(2),position:1,net_ht:'1200.00',purchase_order_line_id:id(5)}],
      artifacts:[{id:id(90),sha256:sha,document_id:id(91),version_id:id(92),scan_status:'CLEAN',archived_at:'2026-10-08T10:00:00Z'}]}},
    lines:[{id:id(2),position:1,quantity:'100',unit:'pcs',order_line_id:id(5),receipt_ids:[id(21)],link_valid:true,other_invoice:false}],
    receipts:[{receipt_stock_id:id(20),reception_id:id(30),receipt_line_id:id(21),movement_id:id(10),receipt_quantity:'100',receipt_active:true,
      acquisition_snapshot:acquisition,acquisition_sha256:sha,acquisition_valid:true,sequence:'10',article_id:id(3),source_snapshot:incoming.source_snapshot,
      source_sha256:sha,source_valid:true,proof_complete:true,entry_id:id(40),owner_key:'COMPANY',stock_unit:'u',currency:'EUR',quantity_delta:'100',
      movement_value:'1000',reliability:'DECLARED',entry_valid:true,entry_sha256:sha,entry_snapshot:{schema_version:1,stock_source_sha256:sha,
        acquisition_source_sha256:sha,result:{quantityDelta:'100',movementValue:'1000',movementReliability:'DECLARED'}}}],
    lots:[{lot_id:id(4),article_id:id(3),lot_code:'MP-01',owner_client_id:null,has_opening:false,
      batches:[{batch_id:id(50),level_id:id(51),article_id:id(3),unit:'u',quantity_total:'40',quantity_depreciated:'0'}]}],
    trace:[incoming,trace(11,'OUT','60')],balances:[{article_id:id(3),unit:'u',source_snapshot:{eligible:true,
      scope:{articleId:id(3),owner:'COMPANY',unit:'u',currency:'EUR'},quantity:'40',physical:{eligible:true},previous_entry_id:id(41),
      previous_entry_sha256:sha,projector:{mode:'ACTIVE',initialized:true,formula_version:'CERP-CUMP-1.0.0',reporting_currency:'EUR'},
      checks:{pending:false,blocked:false,capture_missing:false},before_state:{quantity:'40',value:'400',reliability:'DECLARED'}}}]};
}

// Prepared for the final combined acceptance; not executed during development.
describe('sourced material invoice reconciliation',()=>{
  it('keeps the exact variance and separates remaining from consumed material',()=>{
    const p=proposeMaterialInvoiceReconciliation(source());expect(p.calculable).toBe(true);expect(p.projection_ready).toBe(true);
    expect(p.lines[0]).toMatchObject({variance_ht:'200',stock_variance_ht:'80',consumed_variance_ht:'120',source_reliability:'DECLARED'});
    expect(p).toMatchObject({applied:false,posting_available:false,requires_financial_confirmation:true});
  });
  it('does not manufacture a missing original receipt cost',()=>{
    const s=source();s.receipts[0]!.entry_valid=false;s.receipts[0]!.movement_value=null;
    const p=proposeMaterialInvoiceReconciliation(s);expect(p.calculable).toBe(false);expect(p.lines[0]?.variance_ht).toBeNull();
    expect(p.lines[0]?.issues).toContain('MATERIAL_RECEIPT_COST_UNRESOLVED');
  });
  it('rejects a partial invoice, old lot and a previously invoiced receipt',()=>{
    const partial=source();partial.lines[0]!.quantity='50';
    expect(proposeMaterialInvoiceReconciliation(partial).lines[0]?.issues).toContain('MATERIAL_PARTIAL_INVOICE_ALLOCATION_REQUIRED');
    const old=source();old.lots[0]!.has_opening=true;
    expect(proposeMaterialInvoiceReconciliation(old).lines[0]?.issues).toContain('MATERIAL_LOT_LINEAGE_UNRESOLVED');
    const invoiced=source();invoiced.lines[0]!.other_invoice=true;
    expect(proposeMaterialInvoiceReconciliation(invoiced).lines[0]?.issues).toContain('MATERIAL_RECEIPT_ALREADY_INVOICED');
  });
  it('requires all three neutral transfer postings',()=>{
    const s=source(),parent=trace(60,'TRANSFER','10'),out=trace(61,'OUT','10'),incoming=trace(62,'IN','10');
    for(const leg of [out,incoming])Object.assign(leg.source_snapshot as object,{document_type:'STOCK_TRANSFER_INTERNAL',document_id:id(60)});
    s.trace.push(parent,out,incoming);
    expect(proposeMaterialInvoiceReconciliation(s).calculable).toBe(true);
    s.trace.pop();expect(proposeMaterialInvoiceReconciliation(s).lines[0]?.issues).toContain('MATERIAL_LOT_TRANSFER_UNRESOLVED');
  });
  it('does not use company-wide stock to attribute an unrelated receipt to the lot',()=>{
    const s=source();s.trace.push(trace(70,'IN','10'));
    expect(proposeMaterialInvoiceReconciliation(s).lines[0]?.issues).toContain('MATERIAL_LOT_MIXED_OR_RETURNED');
  });
  it('changes its source digest and stays read-only when projection is pending',()=>{
    const s=source(),before=proposeMaterialInvoiceReconciliation(s);
    (s.balances[0]!.source_snapshot as {eligible:boolean}).eligible=false;
    const after=proposeMaterialInvoiceReconciliation(s);expect(after.calculable).toBe(true);expect(after.projection_ready).toBe(false);
    expect(after.source_sha256).not.toBe(before.source_sha256);expect(after.lines[0]?.issues).toContain('MATERIAL_PROJECTION_NOT_READY');
  });
  it('preserves signed discounts and gives an exhausted lot only consumed variance',()=>{
    const discounted=source(),header=discounted.invoice.header_facts as {total_ht:string;lines:Array<{net_ht:string}>};
    header.total_ht='800.00';header.lines[0]!.net_ht='800.00';
    expect(proposeMaterialInvoiceReconciliation(discounted).lines[0]).toMatchObject({variance_ht:'-200',stock_variance_ht:'-80',consumed_variance_ht:'-120'});
    const exhausted=source();exhausted.trace[1]=trace(11,'OUT','100');
    (exhausted.lots[0]!.batches as Array<{quantity_total:string}>)[0]!.quantity_total='0';
    exhausted.balances=[];
    expect(proposeMaterialInvoiceReconciliation(exhausted).lines[0]).toMatchObject({calculable:true,projection_ready:false,
      variance_ht:'200',stock_variance_ht:'0',consumed_variance_ht:'200'});
  });
});
