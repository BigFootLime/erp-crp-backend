import { describe,expect,it } from "vitest";
import { assertCustomerRefundReversible,customerRefundReversalError } from "./customer-refund-reversal";
import { reverseCustomerRefundSchema } from "../validators/customer-refund.validators";
const refund={amount:"60.00",valueDate:"2026-10-14",reversalId:null};
const command={refund_id:"12680000-0000-4000-8000-000000000001",preview_hash:"a".repeat(64),confirm:true,value_date:"2026-10-14",
 booking_date:"2026-10-14",reference:"CORRECTION-RECETTE",reason:"Remboursement enregistré par erreur"};
describe("customer refund reversal facts",()=>{
 it('translates only known correction conflicts into a recoverable response',()=>{
  expect(customerRefundReversalError({code:'23505',constraint:'customer_refund_reversals_refund_id_key'})).toMatchObject({status:409,code:'CUSTOMER_REFUND_ALREADY_REVERSED'});
  expect(customerRefundReversalError({code:'23514',message:'REFUND-REVERSAL-1268 changed'})).toMatchObject({status:409,code:'CUSTOMER_REFUND_REVERSAL_CONFLICT'});
  const unrelated={code:'23514',message:'another database failure'};expect(customerRefundReversalError(unrelated)).toBe(unrelated);
 });
 it("accepts one complete correction after the original refund",()=>expect(()=>assertCustomerRefundReversible(refund,"2026-10-15")).not.toThrow());
 it("refuses another cancellation instead of deleting prior evidence",()=>expect(()=>assertCustomerRefundReversible({...refund,reversalId:"already-saved"})).toThrow());
 it("refuses a correction dated before its original",()=>expect(()=>assertCustomerRefundReversible(refund,"2026-10-13")).toThrow());
 it.each(["0.00","-1.00"])("requires qualified positive refund evidence %s",amount=>expect(()=>assertCustomerRefundReversible({...refund,amount})).toThrow());
 it("does not accept caller-provided amount, client or cash origin",()=>{
  expect(reverseCustomerRefundSchema.safeParse({...command,amount:"60.00"}).success).toBe(false);
  expect(reverseCustomerRefundSchema.safeParse({...command,client_id:"other"}).success).toBe(false);
  expect(reverseCustomerRefundSchema.parse(command)).toEqual(command);
 });
 it("requires confirmation, real calendar dates and a reason",()=>{
  expect(reverseCustomerRefundSchema.safeParse({...command,confirm:false}).success).toBe(false);
  expect(reverseCustomerRefundSchema.safeParse({...command,value_date:"2026-02-30"}).success).toBe(false);
  expect(reverseCustomerRefundSchema.safeParse({...command,reason:"x"}).success).toBe(false);
  expect(reverseCustomerRefundSchema.safeParse({...command,booking_date:"2026-10-13"}).success).toBe(false);
 });
});
