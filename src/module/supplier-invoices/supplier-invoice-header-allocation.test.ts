import {describe,expect,it} from 'vitest';
import {invoiceHeaderAllocationProof,proposeInvoiceHeaderAllocation,readApprovedInvoiceHeaderLine,
  type InvoiceHeaderFacts} from './supplier-invoice-header-allocation';
import {reconcileSupplierCostSources,type SupplierInvoiceCost} from '../margin-engine/domain/supplier-cost-reconciliation';

const id=(suffix:number)=>`11111111-1111-4111-8111-${String(suffix).padStart(12,'0')}`;
const facts:InvoiceHeaderFacts={invoice_id:id(1),currency:'EUR',document_type:'INVOICE',total_ht:'100.01',
  match_version_id:id(2),match_purchase_order_id:id(3),match_outcome:'MATCHED',supplier_matches:true,
  artifacts:[{id:id(4),sha256:'a'.repeat(64),document_id:id(5),version_id:id(6),scan_status:'CLEAN',archived_at:'2026-10-08T12:00:00Z'}],
  lines:[1,2,3].map(position=>({id:id(10+position),position,net_ht:position===3?'33.34':'33.33',purchase_order_line_id:id(20+position)}))};

// Prepared NOT RUN until the final combined acceptance requested by the user.
describe('documented invoice header allocation',()=>{
  it('retains one cent exactly and is independent of SQL source order',()=>{
    const proposal=proposeInvoiceHeaderAllocation(facts);
    expect(proposal.lines.map(line=>line.header_amount_ht)).toEqual(['0.00','0.01','0.00']);
    expect(proposal.lines.map(line=>line.total_ht)).toEqual(['33.33','33.34','33.34']);
    expect(proposeInvoiceHeaderAllocation({...facts,lines:[...facts.lines].reverse()})).toEqual(proposal);
  });
  it('never loses cents above JavaScript safe integer precision',()=>{
    const proposal=proposeInvoiceHeaderAllocation({...facts,total_ht:'9999999999999999.99',
      lines:[{...facts.lines[0],net_ht:'9999999999999999.98'}]});
    expect(proposal.lines[0].total_ht).toBe('9999999999999999.99');
    expect(proposal.lines[0].header_amount_ht).toBe('0.01');
  });
  it('distributes a discount and both documented credit-note sign conventions',()=>{
    const discount=proposeInvoiceHeaderAllocation({...facts,total_ht:'90.00'});
    expect(discount.lines.map(line=>line.total_ht)).toEqual(['30.00','29.99','30.01']);
    const negative=proposeInvoiceHeaderAllocation({...facts,document_type:'CREDIT_NOTE',total_ht:'-90.00',
      lines:facts.lines.map(line=>({...line,net_ht:'-'+line.net_ht}))});
    expect(negative.lines.map(line=>line.total_ht)).toEqual(['-30.00','-29.99','-30.01']);
    expect(proposeInvoiceHeaderAllocation({...facts,document_type:'CREDIT_NOTE'}).eligible).toBe(true);
  });
  it('rejects mixed signs, missing scope/archives, duplicated lines and nonfinite values',()=>{
    for(const patch of [{lines:[...facts.lines,{...facts.lines[0]}]},
      {lines:[{...facts.lines[0],net_ht:'-1.00'},...facts.lines.slice(1)]},
      {lines:[{...facts.lines[0],purchase_order_line_id:null},...facts.lines.slice(1)]},
      {total_ht:'NaN'}, {supplier_matches:false}, {artifacts:[]},
      {artifacts:[{...facts.artifacts[0],version_id:null}]}])
      expect(proposeInvoiceHeaderAllocation({...facts,...patch}).eligible).toBe(false);
  });
  it('rejects a forged, missing or changed fiscal/archive proof',()=>{
    const proof=invoiceHeaderAllocationProof(proposeInvoiceHeaderAllocation(facts));
    expect(readApprovedInvoiceHeaderLine(facts,proof,id(12))).toBe('33.34');
    expect(readApprovedInvoiceHeaderLine(facts,null,id(12))).toBeNull();
    expect(readApprovedInvoiceHeaderLine({...facts,total_ht:'101.01'},proof,id(12))).toBeNull();
    expect(readApprovedInvoiceHeaderLine({...facts,artifacts:[{...facts.artifacts[0],sha256:'b'.repeat(64)}]},proof,id(12))).toBeNull();
    expect(readApprovedInvoiceHeaderLine(facts,{...proof,lines:proof.lines.map(line=>({...line,total_ht:'0.00'}))},id(12))).toBeNull();
    expect(readApprovedInvoiceHeaderLine(facts,proof,id(99))).toBeNull();
  });
  it('uses one complete proof for several order lines of the same scoped OF',()=>{
    const proposal=proposeInvoiceHeaderAllocation(facts),proof=invoiceHeaderAllocationProof(proposal);
    const rows:SupplierInvoiceCost[]=facts.lines.map((line,index)=>({key:line.id,category:'SUBCONTRACTING',amount_ht:line.net_ht,
      source_type:'SUPPLIER_INVOICE_APPROVED_LINE',source_ref:line.id,observed_at:'2026-10-08',source_reliability:'VERIFIED',currency:'EUR',
      order_line_id:line.purchase_order_line_id!,invoice_id:facts.invoice_id,document_type:'INVOICE',invoiced_quantity:'1',invoice_unit:'u',
      purchase_unit:'u',purchase_currency:'EUR',supplier_matches:true,receipt_links_valid:true,archive_ready:true,header_allocated:false,
      invoice_line_id:line.id,invoice_total_ht:facts.total_ht,invoice_header_facts:index===0?facts:null,approved_header_allocation:index===0?proof:null}));
    const receipts=rows.map(row=>({...row,receipt_quantity:'1',amount_ht:'35.00'}));
    expect(reconcileSupplierCostSources(receipts,rows).map(row=>row.amount_ht)).toEqual(['33.330000','33.340000','33.340000']);
    expect(reconcileSupplierCostSources(receipts,rows.map(row=>({...row,approved_header_allocation:null}))).every(row=>row.amount_ht===null)).toBe(true);
  });
});
