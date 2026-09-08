import {describe,expect,it,vi} from "vitest";
import {resolveReceiptLotContext} from "./quality-receipt-lot-context";
import {applyMaterialLotDecision} from "./quality-material-lot-decision";
import {evaluateReleaseRequest,EMPTY_LEDGER,assertQuantityLedger} from "../domain/quality-release";
import type {ExecutionPreviewBodyDTO} from "../validators/quality-360.validators";
const body:ExecutionPreviewBodyDTO={source_type:"LOT",source_id:"lot",lot_id:"lot",reception_ligne_id:"line",article_id:"article",trigger:"RECEPTION",population:6000,unite:"mm"};
const incoming={lot_id:"lot",article_id:"article",piece_id:null,famille_id:null,fournisseur_id:"supplier",status:"OPEN",unit:"barre",stock_unit:"mm",stock_conversion_coef:3000,article_unit:"mm",qty:2};
describe("Material receipt quality context",()=>{
  it("uses the immutable received conversion before any stock exists",async()=>{
    const q={query:vi.fn(async()=>({rows:[incoming]}))};
    expect(await resolveReceiptLotContext(q as never,body,true)).toMatchObject({population:6000,fournisseur_id:"supplier",unite:"mm"});
    expect(q.query).toHaveBeenCalledTimes(2);
  });
  it.each([
    [{population:3000},"QUALITY_RECEIPT_POPULATION_CHANGED"],
    [{unite:"barre"},"QUALITY_RECEIPT_UNIT_MISMATCH"],
    [{article_id:"other"},"QUALITY_RECEIPT_SCOPE_CHANGED"],
    [{fournisseur_id:"other"},"QUALITY_RECEIPT_SCOPE_CHANGED"],
    [{of_id:19},"QUALITY_RECEIPT_SCOPE_INVALID"],
  ])("rejects altered incoming scope %o",async(patch,code)=>{
    await expect(resolveReceiptLotContext({query:async()=>({rows:[incoming]})} as never,{...body,...patch})).rejects.toMatchObject({code});
  });
  it("keeps the unaccepted portion held in the canonical ledger",()=>{
    const result=evaluateReleaseRequest({decision:"PARTIAL",qty:60,unit:"u",ledger:{...EMPTY_LEDGER,population:100,controlled:100,conforming:100},verdict:"CONFORME",hasDerogation:false,evidenceCount:0});
    expect(result.ledger).toMatchObject({released:60,held:40});expect(()=>assertQuantityLedger(result.ledger)).not.toThrow();
  });
  it("keeps rejected quantities traceable without inventing a supplier return",()=>{
    const result=evaluateReleaseRequest({decision:"REJECT",qty:100,unit:"u",ledger:{...EMPTY_LEDGER,population:100,controlled:100,conforming:0},verdict:"NON_CONFORME",hasDerogation:false,evidenceCount:0});
    expect(result).toMatchObject({qty_released:0,qty_held:100,ledger:{held:100,returned:0,released:0}});
    expect(()=>assertQuantityLedger(result.ledger)).not.toThrow();
  });
  it("records a material release without changing delivery policy",async()=>{
    const q={query:vi.fn(async(sql:string)=>({rows:sql.includes("SELECT lot_status")?[{lot_status:"EN_ATTENTE"}]:sql.includes("SELECT id::text")?[{id:"control"}]:[]}))};
    const execution={id:"control",source_type:"LOT",source_id:"lot",lot_id:"lot",trigger_type:"RECEPTION",correlation_id:null};
    expect(await applyMaterialLotDecision(q as never,{execution,decision:"PARTIAL",released:60,unit:"u",actorId:1,decisionId:"decision"})).toMatchObject({before:"EN_ATTENTE",after:"LIBERE",released_quantity:60});
    q.query.mockClear();
    expect(await applyMaterialLotDecision(q as never,{execution:{...execution,trigger_type:"LOT_RELEASE"},decision:"FULL",released:60,unit:"u",actorId:1,decisionId:"decision"})).toBeNull();
    expect(q.query).not.toHaveBeenCalled();
  });
});
