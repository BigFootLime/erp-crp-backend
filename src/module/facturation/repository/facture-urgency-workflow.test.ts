import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn(),release:vi.fn(),acquire:vi.fn(),audit:vi.fn(),event:vi.fn(),receipt:vi.fn()}));
vi.mock('../../../config/database',()=>({default:{query:mocks.query,connect:async()=>({query:mocks.query,release:mocks.release})}}));
vi.mock('./workflow.repository.shared',async()=>({
  ...await vi.importActual<typeof import('./workflow.repository.shared')>('./workflow.repository.shared'),
  acquireFinanceIdempotency:mocks.acquire,insertGlobalFinanceAudit:mocks.audit,insertFinanceEvent:mocks.event,
  saveFinanceReceipt:mocks.receipt,nextLegacyId:async()=>1,issuerSnapshotAt:async()=>({name:'Fixture issuer'}),
}));
import {repoPreviewFacture,repoCreateFactureDraft} from './facture-workflow.repository';
import {facturePreviewBodySchema} from '../validators/workflow.validators';
const input=facturePreviewBodySchema.parse({client_id:'C1',currency:'EUR',
  sources:[{source_type:'DELIVERY_LINE',source_id:'BL1',source_line_id:'line1',quantity:'2.000'},
    {source_type:'DELIVERY_LINE',source_id:'BL2',source_line_id:'line2',quantity:'3.000'}],
  due_dates:[{due_date:'2026-12-01',label:'Solde'}],
  regulatory:{billing_frame_code:'B1',operation_category:'GOODS',transaction_scope:'FR_PRIVATE_B2B'}});
const actor={userId:8,path:'/factures',requestId:'fixture'};
const charge={id:'00000000-0000-4000-8000-000000000021',commande_id:'10',numero:'CC10',client_id:'C1',amount_ht:'35.50',currency:'EUR',tax_rate_percent:'20.0000',settings_version:1};
let claimed:boolean,lineNumber:number;
beforeEach(()=>{
  vi.clearAllMocks();claimed=false;lineNumber=0;mocks.acquire.mockResolvedValue({replay:null,idempotencyKey:'key',requestHash:'hash'});
  mocks.query.mockImplementation(async(sql:string,values:unknown[]=[])=>{
    if(sql.includes('FROM public.finance_billing_policies'))return {rows:[{policy_version:'1',legal_entity_code:'1',eligible_delivery_statuses:['SHIPPED'],active:true}]};
    if(sql.includes('AS quantity_source'))return {rows:input.sources.map(s=>({source_id:s.source_id,source_line_id:s.source_line_id,commande_id:'10',affaire_id:'1',
      delivery_status:'SHIPPED',client_id:'C1',client_blocked:false,commande_line_id:'1',designation:'Pièce',code_piece:'P1',
      unit:'u',quantity_source:'10.000',quantity_already_invoiced:'0.000',unit_price_ex_tax:'10.0000',discount_percent:'0.0000',tax_rate_percent:'20.0000',pricing_version:'1'}))};
    if(sql.includes('FROM public.delivery_urgency_order_charges'))return {rows:claimed?[]:[charge]};
    if(sql.includes('buyer_siren'))return {rows:[{buyer_siren:'987654321',delivery_address:null,
      buyer_electronic_address:{scheme:'0225',value:'buyer',directory_entry_id:'entry',verified_at:'2026-10-01'},
      seller_electronic_address:{scheme:'0225',value:'seller',directory_entry_id:'entry',verified_at:'2026-10-01'}}]};
    if(sql.includes('SELECT gen_random_uuid()'))return {rows:[{uuid:'00000000-0000-4000-8000-000000000001'}]};
    if(sql.includes('AS snapshot'))return {rows:[{snapshot:{client_id:'C1'}}]};
    if(sql.includes('INSERT INTO public.facture_ligne'))return {rows:[{id:String(++lineNumber)}]};
    if(sql.includes('INSERT INTO public.facture_urgency_charges'))claimed=true;
    return {rows:[]};
  });
});
describe('urgency fee in the canonical invoice workflow',()=>{
  it('adds one fee for two partial BLs of the same order and includes it in VAT/due totals',async()=>{
    const preview=await repoPreviewFacture(input);
    expect(preview.blockers).toEqual([]);
    expect(preview.lines).toHaveLength(3);expect(preview.lines[2].source_type).toBe('ORDER_CHARGE');
    expect(preview.totals).toMatchObject({subtotal_ex_tax:'85.50',total_tax:'17.10',total_incl_tax:'102.60'});
    expect(preview.due_dates[0].amount).toBe('102.60');
  });
  it('binds the fee to its invoice line without fabricating a delivered quantity allocation',async()=>{
    const preview=await repoPreviewFacture(input);
    await repoCreateFactureDraft({input:{...input,preview_hash:preview.preview_hash},actor,idempotencyKey:'key'});
    expect(mocks.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO public.facture_source_allocations'))).toHaveLength(2);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO public.facture_urgency_charges'),[charge.id,1,'3',8]);
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    const next=await repoPreviewFacture(input);expect(next.lines).toHaveLength(2);expect(next.totals.total_incl_tax).toBe('60.00');
  });
  it('refuses a stale confirmation when another draft already claimed the fee',async()=>{
    const preview=await repoPreviewFacture(input);claimed=true;
    await expect(repoCreateFactureDraft({input:{...input,preview_hash:preview.preview_hash},actor,idempotencyKey:'key'}))
      .rejects.toMatchObject({code:'FACTURE_PREVIEW_CHANGED'});
    expect(lineNumber).toBe(0);expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
  it('does not accept caller-defined urgency prices as input sources',()=>{
    expect(facturePreviewBodySchema.safeParse({...input,sources:[{source_type:'ORDER_CHARGE',source_id:'10',source_line_id:charge.id,quantity:'1'}]}).success).toBe(false);
  });
  it('builds an EC customer invoice draft from a signed external receipt line at the local retail price',async()=>{
    const receiptInput=facturePreviewBodySchema.parse({...input,sources:[{
      source_type:'EXTERNAL_FULFILMENT_RECEIPT_LINE',source_id:'11111111-1111-4111-8111-111111111111',
      source_line_id:'11111111-1111-4111-8111-111111111111:1',quantity:'2.000',
    }]});
    mocks.query.mockImplementation(async(sql:string,values:unknown[]=[])=>{
      if(sql.includes('FROM public.finance_billing_policies'))return {rows:[{policy_version:'1',legal_entity_code:'1',eligible_delivery_statuses:['SHIPPED'],active:true}]};
      if(sql.includes('cerp_intercompany_external_fulfilment_receipt_lines'))return {rows:[{source_id:receiptInput.sources[0].source_id,source_line_id:receiptInput.sources[0].source_line_id,commande_id:'10',affaire_id:null,delivery_status:'SHIPPED',client_id:'C1',client_blocked:false,commande_line_id:'1',designation:'Pièce EC',code_piece:'EC-1',unit:'u',quantity_source:'2.000',quantity_already_invoiced:'0.000',unit_price_ex_tax:'42.0000',discount_percent:'0.0000',tax_rate_percent:'20.0000',pricing_version:'receipt-price'}]};
      if(sql.includes('FROM public.delivery_urgency_order_charges'))return {rows:[]};
      if(sql.includes('buyer_siren'))return {rows:[{buyer_siren:'987654321',delivery_address:null,buyer_electronic_address:{scheme:'0225',value:'buyer',directory_entry_id:'b',verified_at:'2026-10-01'},seller_electronic_address:{scheme:'0225',value:'seller',directory_entry_id:'s',verified_at:'2026-10-01'}}]};
      return {rows:[]};
    });
    const preview=await repoPreviewFacture(receiptInput);
    expect(preview.blockers).toEqual([]);
    expect(preview.lines[0]).toMatchObject({source_type:'EXTERNAL_FULFILMENT_RECEIPT_LINE',unit_price_ex_tax:'42.0000',quantity:'2.000'});
    expect(preview.totals.total_ex_tax).toBe('84.00');
  });
  it('reads a preview in one read-only snapshot and releases the connection',async()=>{
    await repoPreviewFacture(input);
    expect(mocks.query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls.some(([sql])=>/^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toBe(false);
  });
  it('rolls back a failed source read without keeping a transaction or recording a draft',async()=>{
    mocks.query.mockImplementationOnce(async()=>({rows:[]})).mockRejectedValueOnce(new Error('fixture source read failure'));
    await expect(repoPreviewFacture(input)).rejects.toThrow('fixture source read failure');
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.receipt).not.toHaveBeenCalled();
  });
});
