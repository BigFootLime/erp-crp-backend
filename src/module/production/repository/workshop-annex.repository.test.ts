import { beforeEach, expect, it, vi } from "vitest";
import type { DbQueryer, OfDocumentRow } from "./of-versioning.repository";
const mock=vi.hoisted(()=>({revision:vi.fn(),plans:vi.fn()}));
vi.mock("./of-versioning.repository",()=>({getRevision:mock.revision}));
vi.mock("./workshop-plan-sources.repository",()=>({readWorkshopPlanSources:mock.plans}));
import { readWorkshopAnnexSources } from "./workshop-annex.repository";
const uuid=(n:number)=>`13200000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const snapshot={version:{id:uuid(1)},piece:{code:"QUAL"},documents:[{id:uuid(2),version_id:uuid(3),sha256:"a".repeat(64),role:"PLAN_CLIENT"}],
  preparation_evidence:{quality_plan:{id:uuid(4)}}};
const document={id:uuid(6),of_id:7,revision_id:uuid(5),payload:{quantiteLancee:40,
  technicalEvidence:{source:{hash:"technical-hash",technicalVersionId:uuid(1)}}}} as OfDocumentRow;
let query:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  vi.resetAllMocks();mock.revision.mockResolvedValue({statut:"ACTIVE",snapshot:{},snapshot_sha256:"revision-hash"});
  mock.plans.mockResolvedValue([{document_id:uuid(2),version_id:uuid(3),sha256:"a".repeat(64),role:"PLAN_CLIENT"}]);
  query=vi.fn().mockResolvedValueOnce({rows:[{snapshot,hash:"technical-hash",sheet_id:uuid(7),execution_plan_id:uuid(8)}]})
    .mockResolvedValue({rows:[{id:uuid(7)}]});
});
const read=()=>readWorkshopAnnexSources({query} as DbQueryer,document);
it("pins the technical definition, exact control plan and quantity from the saved OF",async()=>{
  const result=await read();expect(result.hasClientPlan).toBe(true);expect(result.missingPlans).toEqual([]);
  expect(mock.revision).toHaveBeenCalledWith(7,uuid(5),expect.anything());
  expect(query.mock.calls[1][1]).toEqual([7,uuid(7),uuid(1),uuid(4),40]);
  expect(query.mock.calls[1][0]).toContain("snapshot#>'{of,quantite_lancee}'=to_jsonb($5::numeric)");
});
it("refuses current dossier replacement rather than substituting its plans",async()=>{
  query=vi.fn().mockResolvedValue({rows:[{snapshot,hash:"different"}]});
  await expect(read()).rejects.toMatchObject({code:"WORKSHOP_DEFINITION_UNAVAILABLE"});expect(mock.plans).not.toHaveBeenCalled();
});
it("keeps unavailable or unqualified frozen plans visible as missing annexes",async()=>{
  mock.plans.mockResolvedValue([]);const result=await read();expect(result.hasClientPlan).toBe(false);
  expect(result.missingPlans).toEqual(snapshot.documents);
});
it("does not cast malformed paper UUIDs or fall back to another inspection sheet",async()=>{
  query=vi.fn().mockResolvedValue({rows:[{snapshot,hash:"technical-hash",sheet_id:"broken-id"}]});
  expect((await read()).inspection).toBeNull();expect(query).toHaveBeenCalledTimes(1);
});
