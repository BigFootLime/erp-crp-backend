import { describe,expect,it } from "vitest";
import { planAdvanceCreditVat } from "./advance-credit-vat";
const facts={invoiceId:1,invoiceSha256:"a".repeat(64),original:[{tax_rate:"20.0000",amount_ex_tax:"100.00",tax_amount:"20.00"}],
  cleared:new Map<string,{net:string;tax:string}>(),prior:[]};
describe("frozen VAT correction of paid advances",()=>{
  it("corrects collected VAT once on a fully paid advance",()=>{
    const result=planAdvanceCreditVat({...facts,collected:new Map([["20.0000","20.00"]]),credit:[{tax_rate:"20",amount_ex_tax:"50.00",tax_amount:"10.00"}]});
    expect(result.entries[0].pending_tax).toBe("0.00");expect(result.entries[0].collected_tax).toBe("10.00");
  });
  it("cancels uncollected VAT first, leaving the correct VAT on retained cash",()=>{
    const result=planAdvanceCreditVat({...facts,collected:new Map([["20.0000","13.33"]]),credit:[{tax_rate:"20",amount_ex_tax:"50.00",tax_amount:"10.00"}]});
    expect(result.entries[0].pending_tax).toBe("6.67");expect(result.entries[0].collected_tax).toBe("3.33");
  });
  it("keeps correction of an unpaid advance entirely in pending VAT",()=>{
    const result=planAdvanceCreditVat({...facts,collected:new Map(),credit:[{tax_rate:"20",amount_ex_tax:"100.00",tax_amount:"20.00"}]});
    expect(result.entries[0].pending_tax).toBe("20.00");expect(result.entries[0].collected_tax).toBe("0.00");
  });
  it("does not credit amounts or VAT already applied to final invoices",()=>{
    expect(()=>planAdvanceCreditVat({...facts,collected:new Map([["20.0000","20.00"]]),cleared:new Map([["20.0000",{net:"80.00",tax:"16.00"}]]),
      credit:[{tax_rate:"20",amount_ex_tax:"50.00",tax_amount:"10.00"}]})).toThrow();
  });
});
