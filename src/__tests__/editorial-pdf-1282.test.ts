import { pdfPageTexts } from "./helpers/pdf-text";
import { describe, expect, it } from "vitest";
import { renderCerpDocument, type CerpDocumentHeader } from "../shared/pdf/cerp-document";
import { CERP_LOGO_PNG } from "../shared/pdf/cerp-logo";
import { readableRaster } from "../shared/pdf/editorial-document-blocks";
import { buildOfDocumentPayload } from "../module/production/domain/of-document";
import { renderOfDocument } from "../module/production/services/of-document-render";
import { buildFixtureInput } from "../../test-support/production/of-document.fixture";

const header: CerpDocumentHeader = {
  designVersion: "editorial-v2", documentType: "Fiche suiveuse", name: "OF-TEST-1282", code: "OF-TEST-1282",
  status: "EN COURS", monogramName: "Client fictif", generatedAt: "13/10/2026", title: "Fixture", subject: "Fixture",
  creationDate: new Date("2026-10-13T10:00:00Z"), footerNote: "Document de recette",
};
const content = (bytes: Buffer): string => pdfPageTexts(bytes).join("").replace(/\s/g, "");

describe("Versioned workshop PDF hierarchy", () => {
  it("retains every phase, recorded quantity and final instruction across page breaks", async () => {
    const bytes = await renderCerpDocument(header, ctx => {
      ctx.legalStrip(Array.from({length:6}, (_, i) => ({label:`Identifier ${i}`,value:`VALUE-${i}`})));
      ctx.section("Operations");
      for(let i=1;i<=8;i++) ctx.operationCard({number:String(i*10), title:`Operation-${i}`, fields:[
        {label:"Machine",value:`MACHINE-${i}`}, {label:"Good",value:String(i)}, {label:"Pending",value:"0"},
      ], instructions:`INSTRUCTION-${i} ` + "Read the applicable drawing and retain the material lot. ".repeat(12)});
    });
    const text=content(bytes);
    for(let i=1;i<=8;i++) { expect(text).toContain(`Operation-${i}`); expect(text).toContain(`INSTRUCTION-${i}`); expect(text).toContain(`MACHINE-${i}`); }
    const pageCount=(bytes.toString("latin1").match(/\/Type \/Page\b/g)||[]).length;
    expect(pageCount).toBeGreaterThan(1);
    for(let i=1;i<=pageCount;i++) expect(text).toContain(`Page${i}/${pageCount}`);
  });
  it("keeps full raster bytes and omits corrupt/oversized optional media without breaking the business PDF", async () => {
    expect(readableRaster(CERP_LOGO_PNG)).toBe(CERP_LOGO_PNG);
    expect(readableRaster(Buffer.from("not an image"))).toBeNull();
    expect(readableRaster(Buffer.alloc(8*1024*1024+1))).toBeNull();
    const a=await renderCerpDocument({...header,entityImage:Buffer.from("bad")},ctx=>{
      ctx.visuals([{bytes:Buffer.from("bad"),caption:"INVALID-IMAGE-CAPTION"}]);
      ctx.fieldsGrid([{label:"Quantity",value:"20"}]);
    });
    expect(content(a)).toContain("20");expect(content(a)).not.toContain("INVALID-IMAGE-CAPTION");
    expect((a.toString("latin1").match(/\/Subtype \/Image\b/g)||[]).length).toBe(2); // Official RGB logo + alpha mask only.
  });
  it("retains every long reference and decimal without an orphaned table header", async () => {
    const bytes=await renderCerpDocument(header,ctx=>{
      ctx.section("Lots");ctx.linesTable({columns:[{key:"ref",label:"Reference",flex:3},{key:"qty",label:"Quantity actually received",flex:1,align:"right"}],
        rows:Array.from({length:45},(_,i)=>({cells:{ref:`LOT-LONG-REFERENCE-${i}-INDICE-A`,qty:`${i},125`}})),emptyLabel:"None"});
    });
    const text=content(bytes);
    for(let i=0;i<45;i++) {expect(text).toContain(`LOT-LONG-REFERENCE-${i}-INDICE-A`);expect(text).toContain(`${i},125`);}
  });
  it("does not opt legacy or concurrent documents into the new design implicitly", async () => {
    const [classic,editorial]=await Promise.all([
      renderCerpDocument({...header,designVersion:undefined,name:"CLASSIC"},ctx=>ctx.section("Legacy title")),
      renderCerpDocument({...header,name:"EDITORIAL"},ctx=>ctx.section("New title")),
    ]);
    expect(content(classic)).toContain("Legacytitle");expect(content(classic)).not.toContain("Newtitle");
    expect(content(editorial)).toContain("Newtitle");expect(content(editorial)).not.toContain("Legacytitle");
  });
  it("renders saved OF1.2 with the legacy layout while new1.3 keeps its phase visas and precise unit times", async () => {
    const old=buildOfDocumentPayload(buildFixtureInput({templateVersion:"of-ordre-fabrication/1.2"}));
    const fresh=buildOfDocumentPayload(buildFixtureInput());
    const [legacy,next]=await Promise.all([renderOfDocument(old),renderOfDocument(fresh)]);
    expect(content(legacy.buffer)).toContain("GAMMEAPPLICABLE");
    const text=content(next.buffer);
    expect(text).toContain("Gammeapplicable");
    expect(text).toContain("0,035h/pièce");
    expect(text).toContain("25/04/2026à10:00");
    expect(text).toContain("ContrôlefinalOK");
    expect(text).not.toContain(fresh.snapshotSha256);
    expect(text).not.toContain(fresh.snapshotId);
    expect(fresh.snapshotId).toBe(old.snapshotId); // Identifiers remain in the frozen payload.
  });
});
