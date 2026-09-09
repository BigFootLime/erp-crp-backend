import { describe,expect,it } from "vitest";
import { acceptedReceiptInterval,consumableCoverage,selectConsumableStock } from "./consumable-coverage";

const base={mode:"UNIT" as const,required:120,stockAvailable:30,availablePacks:0,articlePack:100,
  reserved:0,consumed:0,expected:0,receivedBlocked:0,receivedAccepted:0,sharedExpected:0};
describe("consumable OF coverage",()=>{
  it("does not transfer acceptance from a later delivery to the preceding OF",()=>{
    const receipts=[{quantity:60,accepted:20},{quantity:40,accepted:40}];
    expect(acceptedReceiptInterval(0,60,receipts)).toEqual({received:60,accepted:20});
    expect(acceptedReceiptInterval(60,40,receipts)).toEqual({received:40,accepted:40});
    expect(acceptedReceiptInterval(0,100,receipts)).toEqual({received:100,accepted:60});
  });
  it("reserves 30 and buys 100, assigning only 90 to the OF",()=>{
    const c=consumableCoverage(base);expect(c.reserve).toBe(30);expect(c.purchase).toMatchObject({ordered:100,assigned:90,surplus:10});
  });
  it("does not reorder quantities already issued, reserved or on order",()=>{
    const c=consumableCoverage({...base,consumed:20,reserved:10,expected:90});
    expect(c.purchase.ordered).toBe(0);expect(c.reserve).toBe(0);expect(c.available).toBe(false);
  });
  it("keeps received quantities awaiting quality unavailable without buying them twice",()=>{
    const c=consumableCoverage({...base,stockAvailable:0,receivedBlocked:60,expected:60});
    expect(c.available).toBe(false);expect(c.purchase.ordered).toBe(0);
  });
  it("shares a palette across OFs without unit reservations",()=>{
    for(const required of [120,300])expect(consumableCoverage({...base,mode:"GLOBAL_PACK",availablePacks:1,required})).toMatchObject({available:true,reserve:0,assigned:0,replenishmentSuggested:false});
    expect(consumableCoverage({...base,mode:"GLOBAL_PACK",availablePacks:0,sharedExpected:100}).purchase.ordered).toBe(0);
    expect(consumableCoverage({...base,mode:"GLOBAL_PACK",availablePacks:0}).purchase.ordered).toBe(100);
  });
  it("covers non-stock articles by accepted receipts without reserving warehouse quantities",()=>{
    const partial=consumableCoverage({...base,mode:"NONE",stockAvailable:1000,receivedAccepted:60,expected:60});
    expect(partial.reserve).toBe(0);expect(partial.available).toBe(false);expect(partial.purchase.ordered).toBe(0);
    expect(consumableCoverage({...base,mode:"NONE",receivedAccepted:120}).available).toBe(true);
  });
  it("does not propose the same stock twice within an OF",()=>{
    const pool=new Map<string,number>();const stock=[{key:"one",available:30}];
    expect(selectConsumableStock(stock,20,pool).shortage).toBe(0);
    expect(selectConsumableStock(stock,20,pool).shortage).toBe(10);
  });
});
