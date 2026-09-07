import {describe,it,expect} from "vitest";
import {receiptUnitConversion,convertedStockQuantity} from "./receipt-unit-conversion";
describe("Explicit receipt units",()=>{
  it("keeps unitary blanks unchanged",()=>{expect(receiptUnitConversion({receiptUnit:"u",articleUnit:"u"})).toEqual({receiptUnit:"u",stockUnit:"u",coefficient:1});});
  it("converts purchased bars to stock length with the captured rule",()=>{const conversion=receiptUnitConversion({receiptUnit:"barre",articleUnit:"mm",purchase:{unit:"barre",stockUnit:"mm",coefficient:3000}});expect(convertedStockQuantity(2,conversion.coefficient)).toBe(6000);});
  it("rejects guessed conversions and purchase-unit substitutions",()=>{expect(()=>receiptUnitConversion({receiptUnit:"kg",articleUnit:"u"})).toThrow(/conversion/);expect(()=>receiptUnitConversion({receiptUnit:"mm",articleUnit:"mm",purchase:{unit:"barre",stockUnit:"mm",coefficient:3000}})).toThrow(/commande fournisseur/);});
  it("does not silently round fractional stock away",()=>{expect(()=>convertedStockQuantity(1,0.0001)).toThrow(/décimales/);expect(convertedStockQuantity(0.3,0.1)).toBe(0.03);});
});
