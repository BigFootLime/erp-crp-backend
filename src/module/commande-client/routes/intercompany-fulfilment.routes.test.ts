import { describe, expect, it, vi } from "vitest";
import { contextForBuyer, readIntercompanyFulfilmentReceipts } from "./intercompany-fulfilment.routes";

const ids={company:"11111111-1111-4111-8111-111111111111",message:"22222222-2222-4222-8222-222222222222",receipt:"33333333-3333-4333-8333-333333333333",purchaseLine:"44444444-4444-4444-8444-444444444444"};
const row={message_id:ids.message,receipt_id:ids.receipt,seller_delivery_id:"seller-bl",seller_delivery_number:"BL-42",dispatched_at:"2026-10-27T08:00:00.000Z",received_at:"2026-10-27T08:01:00.000Z",document_id:"snapshot-42",document_kind:"AUTHORITATIVE_SNAPSHOT" as const,document_snapshot_sha256:"a".repeat(64),buyer_sales_order_id:"42",commande_numero:"EC-42",client_id:"CLIENT-42",client_name:"Client final",line_no:1,buyer_sales_order_line_id:"420",buyer_purchase_order_line_id:ids.purchaseLine,designation:"Crosse",code_piece:"EC-1",unit:"u",quantity_proved:"3.000",quantity_invoiced:"1.250"};

describe("intercompany fulfilment receipt DTO",()=>{
 it("uses only buyer company/environment scope and returns exact allocatable source identity",async()=>{
  const query=vi.fn().mockResolvedValue({rows:[row]});
  const out=await readIntercompanyFulfilmentReceipts({query} as never,{company_id:ids.company,environment:"cerp_prod"});
  expect(query.mock.calls[0]?.[0]).toContain("receipt.destination_company_id=$1::uuid");
  expect(query.mock.calls[0]?.[1]).toEqual([ids.company,"cerp_prod"]);
  expect(out[0]?.lines[0]).toMatchObject({source_type:"EXTERNAL_FULFILMENT_RECEIPT_LINE",source_id:ids.message,source_line_id:`${ids.message}:1`,quantity_available:"1.750"});
  expect(out[0]?.document).toEqual({id:"snapshot-42",kind:"AUTHORITATIVE_SNAPSHOT",snapshot_sha256:"a".repeat(64),publication_ready:false,native_document:null});
 });
 it("does not leak a receipt that does not match the resolved buyer company",async()=>{
  const query=vi.fn().mockResolvedValue({rows:[]});
  await expect(readIntercompanyFulfilmentReceipts({query} as never,{company_id:ids.company,environment:"cerp_test"},ids.message)).resolves.toEqual([]);
  expect(query.mock.calls[0]?.[1]).toEqual([ids.company,"cerp_test",ids.message]);
 });
 it("clamps consumed draft/issued allocations to no available quantity",async()=>{
  const query=vi.fn().mockResolvedValue({rows:[{...row,quantity_invoiced:"4.000"}]});
  const out=await readIntercompanyFulfilmentReceipts({query} as never,{company_id:ids.company,environment:"cerp_prod"});
  expect(out[0]?.lines[0]?.quantity_available).toBe("0.000");
 });
 it("rejects a companyless request before any receipt read",()=>{
  expect(()=>contextForBuyer({} as never)).toThrow(expect.objectContaining({code:"COMPANY_CONTEXT_REQUIRED"}));
 });
});
