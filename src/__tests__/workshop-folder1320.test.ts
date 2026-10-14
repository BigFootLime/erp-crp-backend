import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock=vi.hoisted(()=>({getDocument:vi.fn(),key:vi.fn(),source:vi.fn(),insert:vi.fn(),bind:vi.fn(),copy:vi.fn(),saveCopy:vi.fn(),get:vi.fn(),
  printMapping:vi.fn(),savePrint:vi.fn(),annexes:vi.fn(),dossier:vi.fn(),build:vi.fn(),emit:vi.fn(),archive:vi.fn(),compensate:vi.fn(),
  read:vi.fn(),blob:vi.fn(),original:vi.fn(),compose:vi.fn(),support:vi.fn(),kind:vi.fn(),print:vi.fn(),audit:vi.fn(),uncertain:false}));
vi.mock("../module/production/repository/of-versioning.repository",()=>{
  class OfCommitUncertainError extends Error {}
  return {OfCommitUncertainError,getDocument:mock.getDocument,getOfficialDocument:vi.fn(async()=>null),lockOf:vi.fn(),
    withOfDocumentReadTransaction:async(fn:any)=>fn({}),withOfTransaction:async(fn:any,hooks:any)=>{
      let value;try {value=await fn({});}catch(error){await hooks?.afterConfirmedRollback?.();throw error;}
      if(mock.uncertain)throw new OfCommitUncertainError();return value;
    }};
});
vi.mock("../module/production/repository/workshop-folder.repository",()=>({findWorkshopFolderByKey:mock.key,findWorkshopFolderBySource:mock.source,
  insertWorkshopFolder:mock.insert,bindWorkshopFolderPreparation:mock.bind,getWorkshopFolderCopy:mock.copy,insertWorkshopFolderCopy:mock.saveCopy,
  getWorkshopFolder:mock.get,getWorkshopFolderPrint:mock.printMapping,insertWorkshopFolderPrint:mock.savePrint,workshopPreparationKind:mock.kind}));
vi.mock("../module/production/repository/workshop-annex.repository",()=>({readWorkshopAnnexSources:mock.annexes}));
vi.mock("../module/production/repository/of-dossier.repository",()=>({readOfDossierTx:mock.dossier}));
vi.mock("../module/production/services/of-versioning.service",()=>({buildDocumentPayload:mock.build,emitDocument:mock.emit}));
vi.mock("../module/production/services/of-document-stored-pdf",()=>({readOfDocumentStoredPdf:mock.original}));
vi.mock("../module/production/services/of-document-archive",()=>({archiveOfDocument:mock.archive,compensateOfDocumentArchive:mock.compensate,readArchivedOfDocument:mock.read}));
vi.mock("../module/ged/services/ged-vault.service",()=>({readBlob:mock.blob}));
vi.mock("../module/production/services/workshop-pack-pdf",()=>({composeWorkshopPackPdf:mock.compose}));
vi.mock("../module/production/services/workshop-support-paper",()=>({renderWorkshopSupportPaper:mock.support}));
vi.mock("../module/production/services/of-document-print.service",()=>({requestOfDocumentPrint:mock.print}));
vi.mock("../module/project-office/repository/project-office.repository",()=>({insertAuditLog:mock.audit}));
import { prepareWorkshopFolder, previewWorkshopFolder, printWorkshopFolder } from "../module/production/services/workshop-folder.service";

const hash=(value:Buffer)=>createHash("sha256").update(value).digest("hex");
const bytes=Buffer.from("fixed complete packet"),plan=Buffer.from("client plan"),sheet=Buffer.from("inspection"),support=Buffer.from("support");
const payload={ofNumero:"OF7",revisionCode:"R00",pieceReference:"P7",pieceIndice:"A",generatedAt:"2026-10-14T08:00:00Z",
  sourceFingerprint:"a".repeat(64),snapshotSha256:"b".repeat(64),watermark:null};
const document={id:"document",of_id:7,revision_id:"revision",statut:"OFFICIEL",payload,pdf_sha256:hash(bytes)};
const folder={id:"folder",of_id:7,document_id:"document",revision_id:"revision",document_status:"OFFICIEL",preparation_kind:"PREPARATION_CREATION",preparation_actor_id:42};
const copy={folder_id:"folder",pdf_sha256:hash(bytes),pdf_byte_size:bytes.length,page_count:5,page_manifest:[{kind:"OF",name:"OF7",page_count:1}]};
const actor={userId:42,username:"RECETTE",role:null},audit={} as any;
const prepare=()=>prepareWorkshopFolder(7,"preparation-key",actor,audit);
beforeEach(()=>{
  vi.resetAllMocks();mock.uncertain=false;
  mock.key.mockResolvedValue(null);mock.source.mockResolvedValue(null);mock.get.mockResolvedValue(folder);mock.getDocument.mockResolvedValue(document);
  mock.copy.mockResolvedValue(copy);mock.read.mockResolvedValue(bytes);mock.blob.mockResolvedValue(plan);mock.original.mockResolvedValue({pdf:bytes});
  mock.build.mockResolvedValue({payload,revisionId:"revision"});mock.emit.mockResolvedValue({document});mock.dossier.mockResolvedValue({status:"COMPLETE",executionStatus:"BROUILLON",planning:{planned:1}});
  mock.annexes.mockResolvedValue({hasClientPlan:true,missingPlans:[],plans:[{storage_key:"private/key",size_bytes:plan.length,sha256:hash(plan),role:"PLAN_CLIENT",label:"Plan client",document_id:"plan",version_id:"pinned"}],
    inspection:{id:"sheet",pdf:sheet,pdf_sha256:hash(sheet),source_hash:"f".repeat(64)}});
  mock.kind.mockResolvedValue("PREPARATION_CREATION");mock.support.mockResolvedValue(support);mock.insert.mockResolvedValue(folder);
  mock.compose.mockImplementation(async input=>({bytes,sha256:hash(bytes),pages:5,manifest:input.parts.map((part:any)=>({kind:part.kind,name:part.name,page_count:1}))}));
  mock.archive.mockImplementation(async(_tx,_input,onOwned)=>{const result={archived:true,gedDocumentId:"ged",gedVersionId:"version"};onOwned(result);return result;});
});
describe("Complete workshop packet command",()=>{
  it("archives OF, pinned plan, inspection and both support sheets with all official copy variants",async()=>{
    const result=await prepare();expect(result.folder.pages).toBe(5);
    expect(mock.compose.mock.calls.map(call=>call[0].ofMark)).toEqual([null,"DUPLICATA","OBSOLETE"]);
    expect(mock.compose.mock.calls[0][0].parts.map((part:any)=>part.kind)).toEqual(["OF","PLAN_CLIENT","AUTOCONTROLE","IMPROVEMENT","PREPARATION_CREATION"]);
    expect(mock.saveCopy.mock.calls.map(call=>call[1].copy_mark)).toEqual(["ORIGINAL","DUPLICATA","OBSOLETE"]);
    expect(mock.archive).toHaveBeenCalledTimes(3);expect(mock.bind).toHaveBeenCalledOnce();expect(mock.print).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private/key");
  });
  it("rejects missing plans or inspection before emitting an OF or accepting a copy",async()=>{
    mock.annexes.mockResolvedValue({hasClientPlan:false,missingPlans:[{role:"PLAN_CLIENT"},{role:"PLAN_FABRICATION"}],plans:[],inspection:null});
    await expect(prepare()).rejects.toMatchObject({code:"WORKSHOP_FOLDER_ANNEXES_REQUIRED",details:{actions:[{section:"plan_client"},{section:"plan_fabrication"},{section:"autocontrole"}]}});
    expect(mock.emit).not.toHaveBeenCalled();expect(mock.insert).not.toHaveBeenCalled();
  });
  it("keeps an unplanned complete OF in BROUILLON and passes a planning recheck under its emission lock",async()=>{
    mock.dossier.mockResolvedValue({status:"COMPLETE",executionStatus:"BROUILLON",planning:{planned:0}});
    const draft={...document,statut:"BROUILLON",payload:{...payload,watermark:"BROUILLON"}};
    mock.emit.mockResolvedValue({document:draft});mock.getDocument.mockResolvedValue(draft);mock.insert.mockResolvedValue({...folder,document_status:"BROUILLON"});
    await prepare();expect(mock.emit.mock.calls[0][6]).toBe("BROUILLON");
    expect(mock.compose.mock.calls.map(call=>call[0].ofMark)).toEqual([null,"OBSOLETE"]);
    mock.dossier.mockResolvedValue({status:"COMPLETE",executionStatus:"BROUILLON",planning:{planned:1}});
    await expect(mock.emit.mock.calls[0][7]({})).rejects.toMatchObject({code:"WORKSHOP_PLANNING_CHANGED"});
  });
  it("stops when preparation is withdrawn between source selection and packet commit",async()=>{
    mock.dossier.mockResolvedValueOnce({status:"COMPLETE",executionStatus:"BROUILLON",planning:{planned:1}})
      .mockResolvedValueOnce({status:"INCOMPLETE",executionStatus:"BROUILLON",planning:{planned:1}});
    await expect(prepare()).rejects.toMatchObject({code:"WORKSHOP_PREPARATION_REQUIRED"});expect(mock.insert).not.toHaveBeenCalled();
  });
  it("binds a fresh preparation key to an existing edition and reconciles a lost COMMIT",async()=>{
    mock.source.mockResolvedValue(folder);mock.uncertain=true;mock.key.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(folder);
    const result=await prepare();expect(result.replayed).toBe(true);expect(mock.bind).toHaveBeenCalledOnce();
    expect(mock.archive).not.toHaveBeenCalled();expect(mock.compensate).not.toHaveBeenCalled();
  });
  it("compensates owned archives on a confirmed partial-packet rollback",async()=>{
    mock.saveCopy.mockRejectedValueOnce(new Error("save failed"));await expect(prepare()).rejects.toThrow("save failed");
    expect(mock.compensate).toHaveBeenCalledOnce();expect(mock.bind).not.toHaveBeenCalled();
  });
  it("replays an already prepared edition without looking up newer documents",async()=>{
    mock.key.mockResolvedValue(folder);const result=await prepare();expect(result.replayed).toBe(true);
    expect(mock.build).not.toHaveBeenCalled();expect(mock.annexes).not.toHaveBeenCalled();
    mock.key.mockResolvedValue({...folder,preparation_actor_id:99});await expect(prepare()).rejects.toMatchObject({code:"IDEMPOTENCY_KEY_REUSED"});
  });
  it("rejects altered stored packets and another OF's folder",async()=>{
    mock.read.mockResolvedValue(Buffer.from("altered"));await expect(previewWorkshopFolder(7,"folder")).rejects.toMatchObject({code:"WORKSHOP_FOLDER_COPY_UNAVAILABLE"});
    mock.get.mockResolvedValue(null);await expect(printWorkshopFolder(8,"folder","key",42,audit)).rejects.toMatchObject({code:"WORKSHOP_FOLDER_NOT_FOUND"});
    expect(mock.print).not.toHaveBeenCalled();
  });
  it("chooses and records the complete DUPLICATA inside the accepted OF print transaction",async()=>{
    mock.print.mockImplementation(async(_of,_doc,_key,_actor,_audit,delivery)=>{
      expect(delivery.expectedDocumentStatus).toBe("OFFICIEL");
      const intent={id:"intent",copy_mark:"DUPLICATA"};const pdf=await delivery.deliver({},intent);
      expect(mock.copy).toHaveBeenLastCalledWith({},"folder","DUPLICATA");return {pdf,intent};
    });
    expect((await printWorkshopFolder(7,"folder","print-key",42,audit)).pdf).toBe(bytes);
    expect(mock.savePrint).toHaveBeenCalledWith({},"intent","folder","DUPLICATA");
  });
});
