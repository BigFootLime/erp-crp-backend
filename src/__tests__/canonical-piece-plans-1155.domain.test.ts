import { describe, expect, it } from "vitest";
import { buildDocumentSlots, resolveDocumentRequirements } from "../module/pieces-techniques/domain/document-policy";
const catalog=[{code:"PLAN",label:"Plan client",is_active:true,sort_order:1}];
const resolution=resolveDocumentRequirements({policy:"REQUIRED_FOR_ALL_LINKED_PT",catalog,hasClient:true});
const plan=(id:string,revision:string,date:string)=>({id,original_name:id+".pdf",mime_type:"application/pdf",size_bytes:2396,document_type_code:"PLAN",piece_technique_version_id:revision,created_at:date});
describe("document dossier revision identity",()=>{
  it("prefers the plan of the selected revision over a newer plan of another revision",()=>{
    const slots=buildDocumentSlots({catalog,resolution,canRead:true,currentVersionId:"selected",documents:[plan("old-current","selected","2026-10-01"),plan("newer-other","other","2026-10-11")]});
    expect(slots[0].document?.id).toBe("old-current");expect(slots[0].state).toBe("PRESENT");
  });
  it("keeps an older-only plan obsolete and does not reveal document identity without read access",()=>{
    const input={catalog,resolution,currentVersionId:"selected",documents:[plan("older","other","2026-10-11")]};
    expect(buildDocumentSlots({...input,canRead:true})[0].state).toBe("OBSOLETE");
    expect(buildDocumentSlots({...input,canRead:false})[0].document).toBeNull();
  });
});
