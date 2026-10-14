import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { repoRoot } from "../../../__tests__/helpers/repo-paths";
import { renderProformaDocument, renderProformaOfficialPdf, type ProformaDocumentSnapshot } from "./proforma-document";
import type { AuthoritativePdfArchiveRecord } from "../../../shared/authoritative-documents/authoritative-document.types";
import * as tools from "../domain/decimal-money";
const load = createRequire(resolve(repoRoot, "package.json"));
const fixtureMaker = load(resolve(repoRoot, "docs/testing/fixtures/proforma-document-fixture.cjs")) as (count: number, companies: number, tools: unknown) => ProformaDocumentSnapshot;
const fixture=(count=1,companies=1)=>fixtureMaker(count,companies,tools);
function pdfText(bytes: Buffer): string {
  let offset=0,result="";
  const decoder=new TextDecoder("windows-1252");
  while((offset=bytes.indexOf("stream\n",offset))>=0){
    offset+=7;const end=bytes.indexOf("endstream",offset);if(end<0)break;
    try {const stream=inflateSync(bytes.subarray(offset,end)).toString("latin1");
      result += [...stream.matchAll(/<([a-f0-9\s]+)>/gi)].map(match=>decoder.decode(Buffer.from(match[1]!.replace(/\s/g,""),"hex"))).join("");
    } catch { /* Raster streams are not text. */ }
    offset=end+9;
  }
  return result.replace(/\s/g,"");
}
describe("#1268 structured proforma PDF",()=>{
  it("prints company/affair allocation and frozen precision without technical hashes or a paid flag",async()=>{
    const source=fixture(),before=structuredClone(source),bytes=await renderProformaDocument(source),text=pdfText(bytes);
    expect(text).toContain("PF-EXEMPLE-23149");expect(text).toContain("45252966B");
    expect(text).toContain("CommandeCF000427201");expect(text).toContain("Affaire23149");
    expect(text).toContain("40pièces");expect(text).toContain("10,125€");expect(text).toContain("Cde5%");
    expect(text).toContain("461,70€");expect(text).toContain("14/10/2026");
    expect(text).toContain("neconstituepasunefacturefiscale");expect(text).not.toContain("Éditéle");
    expect(text).not.toContain(source.preview.preview_hash);expect(text).not.toContain("HIDDEN-SHARE");expect(text).not.toContain("Payée");
    expect(bytes.toString('latin1')).toContain('/BaseFont /Helvetica-Bold');expect(source).toEqual(before);
  });
  it("retains all dense lines and both companies with repeated headers",async()=>{
    const bytes=await renderProformaDocument(fixture(24,2)),text=pdfText(bytes);
    expect(text).toContain("SociétéexempleA");expect(text).toContain("SociétéexempleB");
    for(let i=2;i<=24;i++)expect(text).toContain(`EXEMPLE-${String(i).padStart(3,'0')}`);
    expect(text.match(/Article\/commande\/affaire/g)?.length).toBeGreaterThan(2);
    expect(bytes.toString('latin1').match(/\/Type \/Page\b/g)?.length).toBeGreaterThan(3);
  });
  it("rejects malformed dates and a fiscal invoice source instead of mislabelling it",async()=>{
    await expect(renderProformaDocument({...fixture(),issued_at:'invalid'})).rejects.toThrow('PROFORMA_DOCUMENT_SOURCE_INVALID');
    await expect(renderProformaDocument({...fixture(),fiscal_invoice_created:true} as unknown as ProformaDocumentSnapshot)).rejects.toThrow('PROFORMA_DOCUMENT_SOURCE_INVALID');
  });
  it("uses the stored snapshot only for the matching proforma parent and edition",async()=>{
    const source=fixture();
    const archive={entityType:'proforma',entityId:source.id,documentKind:'CUSTOMER_PROFORMA',sourceSnapshot:source} as unknown as AuthoritativePdfArchiveRecord;
    expect((await renderProformaOfficialPdf({archive})).subarray(0,5).toString()).toBe('%PDF-');
    await expect(renderProformaOfficialPdf({archive:{...archive,entityId:'other'}})).rejects.toThrow('AUTHORITATIVE_PDF_PROFORMA_SOURCE_INVALID');
  });
});
