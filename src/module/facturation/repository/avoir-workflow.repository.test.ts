import { beforeEach,describe,expect,it,vi } from "vitest";
const query=vi.hoisted(()=>vi.fn());
vi.mock("../../../config/database",()=>({default:{query}}));
import { repoPreviewAvoir,repoListAvoirEligibleLines } from "./avoir-workflow.repository";
import { avoirPreviewBodySchema } from "../validators/workflow.validators";
const common={facture_id:"42",facture_number:"FIXTURE-42",facture_status:"ISSUED",facture_document_status:"ISSUED",client_id:"fixture",currency:"EUR",
 client_snapshot:{},issuer_snapshot:{},legal_entity_code:"FIXTURE",quantity_invoiced:"1.000",quantity_already_credited:"0.000",unit:"pce",unit_price_ex_tax:"100.0000",
 discount_percent:"0.0000",original_snapshot:null,document_net:"190.00",document_tax:"24.23",document_gross:"214.23",original_global_discount_percent:"5.0000",
 credited_net:"0.00",credited_tax:"0.00",credited_gross:"0.00",code_piece:null};
const rows=[{...common,facture_line_id:"1",line_order:1,designation:"Pièce A",tax_rate_percent:"20.0000",original_net:"100.00",original_tax:"20.00",original_gross:"120.00"},
 {...common,facture_line_id:"2",line_order:2,designation:"Pièce B",tax_rate_percent:"5.5000",original_net:"100.00",original_tax:"5.50",original_gross:"105.50"}];
beforeEach(()=>query.mockReset().mockResolvedValue({rows:structuredClone(rows)}));
describe("credit source preview",()=>{
 it("keeps the same hash before and after PostgreSQL normalizes a quantity to three decimals",async()=>{
  const input={facture_id:42,reason_code:"QUALITY" as const,reason:"Retour de qualification",lines:[{facture_line_id:1,quantity:"1"}]};
  const typed=await repoPreviewAvoir(input),persisted=await repoPreviewAvoir({...input,lines:[{facture_line_id:1,quantity:"1.000"}]});
  expect(typed.preview_hash).toBe(persisted.preview_hash);expect(typed.lines[0].quantity_selected).toBe("1.000");
  expect(typed.totals).toMatchObject({total_ex_tax:"95.00",total_tax:"19.00",total_incl_tax:"114.00",global_discount_amount:"0.00"});
 });
});

describe("monetary advance credit preview",()=>{
 const advance={...rows[0],original_snapshot:{invoice_type_code:386},is_advance_source:true,document_net:"100.00",document_tax:"20.00",
  document_gross:"120.00",original_global_discount_percent:"0.0000"};
 const input={facture_id:42,reason_code:"COMMERCIAL_GESTURE" as const,reason:"Réduction de l'acompte",lines:[{facture_line_id:1,advance_amount_ex_tax:"33.33"}]};
 it("guides the eligible amount and keeps a monetary credit independent of pieces",async()=>{
  query.mockResolvedValue({rows:[advance]});
  const eligible=await repoListAvoirEligibleLines(42),preview=await repoPreviewAvoir(input);
  expect(eligible.lines[0]).toMatchObject({credit_mode:"AMOUNT_EX_TAX",amount_remaining_ex_tax:"100.00",eligible:true});
  expect(preview.lines[0]).toMatchObject({credit_basis:"AMOUNT_EX_TAX",quantity_selected:"1.000",source_quantity_selected:"0.000",
   unit:"acompte",unit_price_ex_tax:"33.33",discount_percent:"0.0000",total_ex_tax:"33.33",tax_amount:"6.67",total_incl_tax:"40.00"});
 });
 it("keeps the preview hash stable after decimal storage normalization",async()=>{
  query.mockResolvedValue({rows:[advance]});
  const a=await repoPreviewAvoir({...input,lines:[{facture_line_id:1,advance_amount_ex_tax:"33.3"}]}),
   b=await repoPreviewAvoir({...input,lines:[{facture_line_id:1,advance_amount_ex_tax:"33.30"}]});
  expect(a.preview_hash).toBe(b.preview_hash);
 });
 it("closes eligibility after monetary exhaustion even though no pieces were credited",async()=>{
  query.mockResolvedValue({rows:[{...advance,credited_net:"100.00",credited_tax:"20.00",credited_gross:"120.00"}]});
  expect((await repoListAvoirEligibleLines(42)).lines[0]).toMatchObject({credit_mode:"AMOUNT_EX_TAX",amount_remaining_ex_tax:"0.00",eligible:false});
  await expect(repoPreviewAvoir(input)).rejects.toMatchObject({code:"AVOIR_AMOUNT_EXCEEDS_REMAINING"});
 });
 it.each([{original_snapshot:{invoice_type_code:380}},{is_advance_source:false},{original_global_discount_percent:"5.0000"}])
  ("refuses an unqualified advance source %j",async override=>{
   query.mockResolvedValue({rows:[{...advance,...override}]});
   await expect(repoPreviewAvoir(input)).rejects.toMatchObject({code:"AVOIR_AMOUNT_REQUIRES_ADVANCE"});
  });
 it.each([{quantity:"1",advance_amount_ex_tax:"33.33"},{},{advance_amount_ex_tax:"0"},{advance_amount_ex_tax:"0.001"}])
  ("validates the exclusive monetary selection %j",selection=>{
   expect(avoirPreviewBodySchema.safeParse({...input,lines:[{facture_line_id:1,...selection}]}).success).toBe(false);
  });
});
