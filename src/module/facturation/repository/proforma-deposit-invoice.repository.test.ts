import { describe,expect,it } from 'vitest';
import { buildProformaDepositInvoiceLine,type ProformaDepositSource } from './proforma-deposit-invoice.repository';
import { facturePreviewBodySchema } from '../validators/workflow.validators';
const proforma='12680000-0000-4000-8000-000000000001',part='12680000-0000-4000-8000-000000000002';
const source:ProformaDepositSource={source_id:proforma,source_line_id:part,proforma_reference:'PF-QUAL1268',status:'ISSUED',billed_client_id:'902',currency:'EUR',
 quantity:'30.000',total_ex_tax:'300.00',total_incl_tax:'360.00',tax_rate_percent:'20.0000',source_revision:'a'.repeat(64),designation:'Article de qualification',code_piece:'QUAL',
 commande_id:'12',affaire_id:'13',already_ex_tax:'0.00',already_incl_tax:'0.00',customer_blocked:false,proforma_part_snapshot:{}};
const selection={source_type:'DEPOSIT' as const,source_id:proforma,source_line_id:part,quantity:'1.000',advance_amount_ex_tax:'100.00'};
describe('monetary invoice advances from issued proformas',()=>{
 it('prices a partial advance with source tax and no physical piece consumption',()=>{
  expect(buildProformaDepositInvoiceLine(source,selection,'902','EUR')).toMatchObject({source_type:'DEPOSIT',quantity:'1.000',unit:'acompte',total_ex_tax:'100.00',tax_amount:'20.00',total_incl_tax:'120.00',discount_percent:'0.0000'});
 });
 it('accepts the exact remaining advance without applying the order discount twice',()=>{
  expect(buildProformaDepositInvoiceLine({...source,already_ex_tax:'100.00',already_incl_tax:'120.00'},{...selection,advance_amount_ex_tax:'200.00'},'902','EUR').total_incl_tax).toBe('240.00');
 });
 it('refuses using another billed company or a mismatched source',()=>{
  expect(()=>buildProformaDepositInvoiceLine(source,selection,'903','EUR')).toThrowError(expect.objectContaining({code:'PROFORMA_DEPOSIT_PARTY_MISMATCH'}));
  expect(()=>buildProformaDepositInvoiceLine(source,{...selection,source_id:part},'902','EUR')).toThrowError(expect.objectContaining({code:'PROFORMA_DEPOSIT_SOURCE_UNAVAILABLE'}));
 });
 it('does not accept unpublished, blocked or currency-mismatched sources',()=>{
  expect(()=>buildProformaDepositInvoiceLine({...source,status:'DRAFT'},selection,'902','EUR')).toThrow();
  expect(()=>buildProformaDepositInvoiceLine({...source,customer_blocked:true},selection,'902','EUR')).toThrow();
  expect(()=>buildProformaDepositInvoiceLine(source,selection,'902','USD')).toThrow();
 });
 it('caps both net and gross budgets, including active drafts',()=>{
  expect(()=>buildProformaDepositInvoiceLine({...source,already_ex_tax:'250.00',already_incl_tax:'300.00'},selection,'902','EUR')).toThrowError(expect.objectContaining({code:'PROFORMA_DEPOSIT_AMOUNT_EXCEEDED'}));
  expect(()=>buildProformaDepositInvoiceLine({...source,already_ex_tax:'0.00',already_incl_tax:'350.00'},selection,'902','EUR')).toThrowError(expect.objectContaining({code:'PROFORMA_DEPOSIT_AMOUNT_EXCEEDED'}));
 });
 it('selects the advance unit automatically instead of requesting a piece quantity',()=>{
  const input={client_id:'902',sources:[{source_type:'DEPOSIT',source_id:proforma,source_line_id:part,advance_amount_ex_tax:'100.00'}],due_dates:[{due_date:'2026-10-31',label:'Acompte'}],regulatory:{billing_frame_code:'B1',operation_category:'GOODS',transaction_scope:'FR_PRIVATE_B2B'}};
  expect(facturePreviewBodySchema.parse(input).sources[0]?.quantity).toBe('1.000');
  expect(facturePreviewBodySchema.safeParse({...input,sources:[{...input.sources[0],quantity:'30'}]}).success).toBe(false);
  expect(facturePreviewBodySchema.safeParse({...input,sources:[{...input.sources[0],advance_amount_ex_tax:'0'}]}).success).toBe(false);
  expect(facturePreviewBodySchema.safeParse({...input,sources:[{...input.sources[0],tax_rate_percent:'0'}]}).success).toBe(false);
 });
});
