import {describe,it,expect,vi} from "vitest";
import {resolveStockLotContext} from "./quality-stock-lot-context";
import type {ExecutionPreviewBodyDTO} from "../validators/quality-360.validators";
const body:ExecutionPreviewBodyDTO={source_type:"LOT",source_id:"lot",lot_id:"lot",article_id:"article",trigger:"RECHECK",population:79,unite:"u"};
const client=()=>({query:vi.fn(async(_sql:string)=>({rows:[{article_id:"article",piece_technique_id:"piece",famille_id:"family",unite:"u",population:79}]}))});
describe("Stock lot recheck context",()=>{
  it("derives the technical scope from the lot and locks it only when creating",async()=>{
    const q=client();expect(await resolveStockLotContext(q as never,body,true)).toMatchObject({piece_technique_id:"piece",famille_id:"family"});
    expect(q.query.mock.calls[0]?.[0]).toContain("FOR UPDATE OF l");
  });
  it.each([
    [{population:80},"QUALITY_STOCK_LOT_QUANTITY_CHANGED"],
    [{unite:"kg"},"QUALITY_STOCK_LOT_UNIT_MISMATCH"],
    [{article_id:"other"},"QUALITY_STOCK_LOT_ARTICLE_MISMATCH"],
    [{of_id:19},"QUALITY_STOCK_LOT_SCOPE_INVALID"],
  ])("rejects a changed or unrelated stock context %o",async(patch,code)=>{await expect(resolveStockLotContext(client() as never,{...body,...patch})).rejects.toMatchObject({code});});
  it("leaves the existing delivery allocation validation to its own resolver",async()=>{const q=client();const delivery={...body,trigger:"LOT_RELEASE" as const};expect(await resolveStockLotContext(q as never,delivery)).toBe(delivery);expect(q.query).not.toHaveBeenCalled();});
});
