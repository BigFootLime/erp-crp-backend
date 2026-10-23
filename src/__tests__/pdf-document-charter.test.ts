import { describe, expect, it } from "vitest";
import { renderCerpDocument } from "../shared/pdf/cerp-document";
import { basePdfRenderVersion, currentPdfPresentation, modulePdfRenderVersion, withArchivePdfPresentation } from "../shared/pdf/document-theme";
import { repoQueueAuthoritativePdf } from "../shared/authoritative-documents/authoritative-document.repository";
import type { AuthoritativePdfCreationInput } from "../shared/authoritative-documents/authoritative-document.types";

const input: AuthoritativePdfCreationInput = { entityType:"piece-technique",entityId:"piece",documentKind:"TECHNICAL_PIECE_CREATION_SNAPSHOT",documentVersion:1,renderVersion:"internal-creation-snapshot-v1",idempotencyKey:"fixture",title:"Pièce",originalName:"piece.pdf",sourceSnapshot:{},sourceRevision:"revision",actorUserId:1 };
const row=(render_version:string)=>({id:"archive",entity_type:input.entityType,entity_id:input.entityId,document_kind:input.documentKind,document_version:1,render_version,idempotency_key:input.idempotencyKey,title:input.title,original_name:input.originalName,source_snapshot:{},source_revision:input.sourceRevision,snapshot_sha256:"hash",created_at:"2026-10-23",created_by:1});

describe("PDF222 module charter and archived presentation",()=>{
  it("isolates concurrent archive policies and restores the default after rendering",async()=>{
    const values=await Promise.all([
      withArchivePdfPresentation("piece-technique","technical-sheet-v1+module-v1",async()=>{await Promise.resolve();return currentPdfPresentation("Document");}),
      withArchivePdfPresentation("client","client-profile-v2",async()=>{await Promise.resolve();return currentPdfPresentation("Document");}),
    ]);
    expect(values).toEqual([{legacy:false,module:"production"},{legacy:true,module:"commerce"}]);
    expect(currentPdfPresentation("Document","stock")).toEqual({legacy:false,module:"stock"});
  });
  it("tags newly queued editions once, while returning an old idempotent receipt unchanged",async()=>{
    expect(basePdfRenderVersion(modulePdfRenderVersion(input.renderVersion))).toBe(input.renderVersion);
    expect(modulePdfRenderVersion(modulePdfRenderVersion(input.renderVersion))).toBe(input.renderVersion+"+module-v1");
    const calls: unknown[][]=[];
    const query=async(sql:unknown,params?:unknown[])=>{calls.push(params??[]);return {rows:String(sql).startsWith("INSERT INTO public.authoritative_pdf_archives")?[]:String(sql).startsWith("SELECT")?[row(input.renderVersion)]:[]};};
    const archive=await repoQueueAuthoritativePdf({query} as never,input,"hash");
    expect(calls[0][4]).toBe(input.renderVersion+"+module-v1");
    expect(archive.renderVersion).toBe(input.renderVersion);
    expect(archive.id).toBe("archive");
  });
  it("does not tag exact bytes and rejects actual renderer changes on idempotent retries",async()=>{
    const query=async(sql:unknown)=>({rows:String(sql).startsWith("SELECT")?[row("different-renderer-v2")]:[]});
    await expect(repoQueueAuthoritativePdf({query} as never,input,"hash")).rejects.toMatchObject({code:"OFFICIAL_DOCUMENT_IDEMPOTENCY_CONFLICT"});
    const bytes=Buffer.from("%PDF-fixture");let version:unknown;
    const exactQuery=async(sql:unknown,params?:unknown[])=>{if(String(sql).startsWith("INSERT INTO public.authoritative_pdf_archives")){version=params?.[4];return {rows:[{...row(input.renderVersion),exact_pdf_sha256:require("node:crypto").createHash("sha256").update(bytes).digest("hex"),exact_pdf_size_bytes:String(bytes.length)}]};}return {rows:[]};};
    await repoQueueAuthoritativePdf({query:exactQuery} as never,{...input,exactPdfBytes:bytes},"hash");expect(version).toBe(input.renderVersion);
  });
  it("embeds Inter for new documents, retains Helvetica for historic jobs, and keeps watermarks",async()=>{
    const header={documentType:"Fiche technique",name:"PT-001",code:"A",status:"Brouillon",watermark:"BROUILLON",generatedAt:"23/10/2026",title:"Pièce",subject:"Recette",creationDate:new Date("2026-10-23T12:00:00Z")};
    const render=()=>renderCerpDocument(header,ctx=>{ctx.section("Définition");ctx.notes("Référence CLI-001");});
    const modern=await withArchivePdfPresentation("piece-technique","v1+module-v1",render);
    const old=await withArchivePdfPresentation("piece-technique","v1",render);
    expect(modern.toString("latin1")).toContain("Inter-Regular");expect(modern.toString("latin1")).toContain("module=production");
    expect(old.toString("latin1")).toContain("/Helvetica");expect(old.toString("latin1")).not.toContain("Inter-Regular");
  });
});
