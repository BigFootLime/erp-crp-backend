import { describe, expect, it } from "vitest";
import { planCustomerRefund, type RefundOrigin } from "./customer-refund";
const origin:RefundOrigin={origin_type:"INVOICE_ALLOCATION",origin_id:"a",payment_id:1,payment_allocation_id:"pa1",payment_number:"PAY-1",
  value_date:"2026-10-14",mode:"VIREMENT",source_available:"80.00",allocation_available:"80.00",payment_available:"100.00"};
describe("guided refund cash origins",()=>{
  it("preselects cash in stable order and does not exceed the note or customer balance",()=>{
    const result=planCustomerRefund({amount:"60.00",invoiceRefundable:6000n,creditRemaining:8000n,origins:[origin]});
    expect(result.sources).toHaveLength(1);expect(result.sources[0].amount).toBe("60.00");
    expect(()=>planCustomerRefund({amount:"60.01",invoiceRefundable:6000n,creditRemaining:8000n,origins:[origin]})).toThrow();
  });
  it("shares payment and allocation budgets across several advance applications",()=>{
    const origins=[{...origin,origin_type:"APPLIED_ADVANCE" as const,origin_id:"one",source_available:"70.00"},
      {...origin,origin_type:"APPLIED_ADVANCE" as const,origin_id:"two",source_available:"70.00"}];
    const result=planCustomerRefund({amount:"80.00",invoiceRefundable:12000n,creditRemaining:12000n,origins});
    expect(result.sources.map(source=>source.amount)).toEqual(["70.00","10.00"]);
    expect(()=>planCustomerRefund({amount:"80.01",invoiceRefundable:12000n,creditRemaining:12000n,origins})).toThrow();
  });
  it("retains direct historical evidence without converting it into an allocation",()=>{
    const result=planCustomerRefund({amount:"100.00",invoiceRefundable:10000n,creditRemaining:10000n,origins:[
      {...origin,origin_type:"INVOICE_DIRECT",payment_allocation_id:null,allocation_available:null,source_available:"100.00"}]});
    expect(result.sources[0].payment_allocation_id).toBeNull();expect(result.sources[0].origin_type).toBe("INVOICE_DIRECT");
  });
  it("rejects duplicate origins, altered parent budgets and insufficient cash",()=>{
    const input={amount:"10.00",invoiceRefundable:1000n,creditRemaining:1000n};
    expect(()=>planCustomerRefund({...input,origins:[origin,origin]})).toThrow();
    expect(()=>planCustomerRefund({...input,origins:[origin,{...origin,origin_id:"b",payment_available:"99.99"}]})).toThrow();
    expect(()=>planCustomerRefund({...input,origins:[{...origin,payment_available:"9.99"}]})).toThrow();
  });
});
