import { beforeEach,describe,expect,it,vi } from "vitest";
const query=vi.hoisted(()=>vi.fn());
vi.mock("../../../config/database",()=>({default:{query}}));
import { repoPreviewAvoir } from "./avoir-workflow.repository";
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
