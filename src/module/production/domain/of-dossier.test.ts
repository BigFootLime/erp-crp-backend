import {describe,it,expect} from "vitest";
import {evaluateDossier,dossierSourceHash,type DossierFacts} from "./of-dossier";
const facts:DossierFacts={id:1,status:"BROUILLON",technicalReadiness:"VALIDATED",technicalHash:"a".repeat(64),revision:"rev",quantity:100,
  operations:[{id:"cut",phase:10,label:"Découpe",planned:true,status:"TODO",setup:.5,unit:.01,base:1,coefficient:1,start:"2026-09-08T07:00Z",end:"2026-09-08T08:30Z",resource:"Didier"}]};
describe("Dossier completion",()=>{
  it("allows missing physical material and does not equate completion with execution",()=>{const r=evaluateDossier(facts);expect(r.canComplete).toBe(true);expect(r.loadMinutes).toBe(90);expect(facts.status).toBe("BROUILLON");});
  it("requires every operation to be planned, not merely one slot",()=>{const r=evaluateDossier({...facts,operations:[...facts.operations,{...facts.operations[0],id:"mill",planned:false}]});expect(r.canComplete).toBe(false);expect(r.blockers[0].operationId).toBe("mill");});
  it("requires a validated immutable technical definition",()=>{expect(evaluateDossier({...facts,technicalReadiness:"INCOMPLETE"}).canComplete).toBe(false);expect(evaluateDossier({...facts,technicalHash:null}).canComplete).toBe(false);});
  it("keeps completion after moving slots, invalidates quantity and routing edits",()=>{const v={source_hash:dossierSourceHash(facts),invalidated_at:null,invalidation_reason:null};expect(evaluateDossier({...facts,operations:[{...facts.operations[0],start:"2026-09-09T07:00Z"}]},v).status).toBe("COMPLETE");expect(evaluateDossier({...facts,quantity:101},v).status).toBe("REVALIDATION_REQUIRED");expect(evaluateDossier({...facts,operations:[{...facts.operations[0],unit:.02}]},v).status).toBe("REVALIDATION_REQUIRED");});
  it("withdrawn and explicitly invalidated dossiers need revalidation",()=>{const v={source_hash:dossierSourceHash(facts),invalidated_at:null,invalidation_reason:null};expect(evaluateDossier({...facts,operations:[{...facts.operations[0],planned:false}]},v).status).toBe("REVALIDATION_REQUIRED");expect(evaluateDossier(facts,{...v,invalidated_at:"now",invalidation_reason:"Retrait"}).status).toBe("REVALIDATION_REQUIRED");});
  it("does not retroactively complete started or closed work",()=>{for(const status of ["EN_COURS","TERMINE","CLOTURE","ANNULE"])expect(evaluateDossier({...facts,status}).canComplete).toBe(false);});
});
