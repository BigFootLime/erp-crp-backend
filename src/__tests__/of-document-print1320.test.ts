import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfDocumentRow } from "../module/production/repository/of-versioning.repository";
import type { OfPrintIntent } from "../module/production/repository/of-document-print.repository";
const mock = vi.hoisted(()=>({lock:vi.fn(),get:vi.fn(),find:vi.fn(),count:vi.fn(),variant:vi.fn(),saveVariant:vi.fn(),insert:vi.fn(),
  original:vi.fn(),read:vi.fn(),archive:vi.fn(),compose:vi.fn(),audit:vi.fn(),cleanup:vi.fn(),commitUncertain:false}));
vi.mock("../module/production/repository/of-versioning.repository",()=>{
  class OfCommitUncertainError extends Error {}
  return {lockOf:mock.lock,getDocument:mock.get,OfCommitUncertainError,
    withOfTransaction:async (fn:any,hooks:any)=>{
      let result;try{result=await fn({});}catch(error){await hooks.afterConfirmedRollback();throw error;}
      if(mock.commitUncertain)throw new OfCommitUncertainError();return result;
    }};
});
vi.mock("../module/production/repository/of-document-print.repository",()=>({lockPrintKey:vi.fn(),findPrintIntent:mock.find,
  officialPrintCount:mock.count,readPrintVariant:mock.variant,insertPrintVariant:mock.saveVariant,insertPrintIntent:mock.insert}));
vi.mock("../module/production/services/of-document-stored-pdf",()=>({readOfDocumentStoredPdf:mock.original}));
vi.mock("../module/production/services/of-document-archive",()=>({archiveOfDocument:mock.archive,
  readArchivedOfDocument:mock.read,compensateOfDocumentArchive:mock.cleanup}));
vi.mock("../module/production/services/workshop-pack-pdf",()=>({composeWorkshopPackPdf:mock.compose}));
vi.mock("../module/project-office/repository/project-office.repository",()=>({insertAuditLog:mock.audit}));
import { requestOfDocumentPrint } from "../module/production/services/of-document-print.service";
const hash=(b:Buffer)=>createHash("sha256").update(b).digest("hex"), original=Buffer.from("original archive"),duplicate=Buffer.from("marked duplicate");
const doc={id:"doc",of_id:7,revision_id:"rev",statut:"OFFICIEL",pdf_sha256:hash(original),pdf_byte_size:original.length,
  reprint_count:99,generated_at:"2026-10-14T08:00:00Z",payload:{ofNumero:"OF7",revisionCode:"R00",pieceReference:"P7",watermark:null}} as OfDocumentRow;
const archive={archived:true,gedDocumentId:"ged-copy",gedVersionId:"ged-version",blobOwnership:{kind:"created"}};
let saved:OfPrintIntent|null;
beforeEach(()=>{
  vi.resetAllMocks();mock.commitUncertain=false;saved=null;
  mock.get.mockResolvedValue(doc);mock.find.mockImplementation(async()=>saved);mock.count.mockResolvedValue(0);
  mock.variant.mockResolvedValue(null);mock.original.mockResolvedValue({pdf:original,source:"GED"});
  mock.compose.mockResolvedValue({bytes:duplicate,sha256:hash(duplicate)});mock.archive.mockResolvedValue(archive);
  mock.read.mockResolvedValue(duplicate);mock.insert.mockImplementation(async(_tx,_key,row)=>saved={...row,id:"intent",created_at:"now"});
});
const print=()=>requestOfDocumentPrint(7,"doc","print-key-1320",42,{} as any);
describe("OF print requests are distinct from archive reads",()=>{
  it("serves the first official original byte-for-byte despite historical GET counters",async()=>{
    const result=await print();expect(result.pdf).toBe(original);expect(result.intent).toMatchObject({official_ordinal:1,copy_mark:null});
    expect(mock.archive).not.toHaveBeenCalled();expect(mock.compose).not.toHaveBeenCalled();
    expect(mock.audit.mock.calls[0][2].details.physical_print_confirmed).toBe(false);
  });
  it("archives a separate DUPLICATA then replays exactly without another ordinal or archive",async()=>{
    mock.count.mockResolvedValue(1);const first=await print();const replay=await print();
    expect(first.intent).toMatchObject({official_ordinal:2,copy_mark:"DUPLICATA"});expect(replay.replayed).toBe(true);
    expect(replay.pdf.equals(first.pdf)).toBe(true);expect(mock.insert).toHaveBeenCalledTimes(1);expect(mock.archive).toHaveBeenCalledTimes(1);
    expect(mock.archive.mock.calls[0][1].existingGedDocumentId).toBeNull();expect(doc.pdf_sha256).toBe(hash(original));
  });
  it("retains a saved BROUILLON and allocates no official ordinal",async()=>{
    mock.get.mockResolvedValue({...doc,statut:"BROUILLON",payload:{...doc.payload as any,watermark:"BROUILLON"}});
    const first=await print(),second=await print();expect(first.intent).toMatchObject({official_ordinal:null,copy_mark:"BROUILLON"});
    expect(second.pdf).toBe(original);expect(mock.count).not.toHaveBeenCalled();expect(mock.compose).not.toHaveBeenCalled();
  });
  it("does not accept an ordinal if source rendering or archive creation fails",async()=>{
    mock.count.mockResolvedValue(1);mock.archive.mockResolvedValue({archived:false});
    await expect(print()).rejects.toMatchObject({code:"OF_PRINT_ARCHIVE_REQUIRED"});expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.cleanup).toHaveBeenCalled();
    mock.original.mockRejectedValue(new Error("corrupt original"));await expect(print()).rejects.toThrow("corrupt original");
    expect(mock.insert).not.toHaveBeenCalled();
  });
  it("rejects a key from another actor/OF and refuses to print a newly obsolete old intent",async()=>{
    await print();saved={...saved!,actor_id:99};await expect(print()).rejects.toMatchObject({code:"IDEMPOTENCY_KEY_REUSED"});
    saved={...saved!,actor_id:42};mock.get.mockResolvedValue({...doc,statut:"OBSOLETE"});
    await expect(print()).rejects.toMatchObject({code:"OF_PRINT_VERSION_CHANGED"});
  });
  it("reads an archived variant without rendering it again and refuses altered copies",async()=>{
    mock.count.mockResolvedValue(4);mock.variant.mockResolvedValue({pdf_sha256:hash(duplicate),pdf_byte_size:duplicate.length});
    expect((await print()).intent.official_ordinal).toBe(5);expect(mock.compose).not.toHaveBeenCalled();
    saved=null;mock.read.mockResolvedValue(Buffer.from("changed"));await expect(print()).rejects.toMatchObject({code:"OF_PRINT_COPY_UNAVAILABLE"});
  });
  it("reconciles an acknowledged database intent after a lost COMMIT response",async()=>{
    mock.commitUncertain=true;const result=await print();expect(result.replayed).toBe(true);expect(result.pdf).toBe(original);
    expect(mock.insert).toHaveBeenCalledTimes(1);expect(mock.cleanup).not.toHaveBeenCalled();
  });
  it("does not leak documents from another OF",async()=>{
    mock.get.mockResolvedValue(null);await expect(print()).rejects.toMatchObject({code:"OF_DOCUMENT_NOT_FOUND"});
    expect(mock.original).not.toHaveBeenCalled();expect(mock.insert).not.toHaveBeenCalled();
  });
});
