import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { composeWorkshopPackPdf } from "./workshop-pack-pdf";
import { CERP_LOGO_PNG } from "../../../shared/pdf/cerp-logo";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const at = "2026-10-14T08:00:00.000Z";
async function part(kind: string, width = 595, height = 842) {
  const pdf = await PDFDocument.create(), page = pdf.addPage([width, height]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.setCreationDate(new Date(at)); pdf.setModificationDate(new Date(at));
  page.drawText(`Document ${kind}`, { font, x: 36, y: height - 50, size: 12 });
  if (kind === "PLAN_CLIENT") {
    const annotation = pdf.context.obj({ Type: "Annot", Subtype: "Text", Rect: [50, 50, 75, 75],
      Contents: PDFString.of("Tolerance a conserver"), A: { S: "URI", URI: PDFString.of("https://example.invalid") } });
    page.node.set(PDFName.of("Annots"), pdf.context.obj([pdf.context.register(annotation)]));
  }
  const bytes = Buffer.from(await pdf.save());
  return { kind, name: kind, bytes, sha256: hash(bytes) };
}

describe("server assembly of immutable workshop print copies", () => {
  it("assembles the OF and annexes in order while retaining page geometry and plan notes", async () => {
    const parts = [await part("OF"), await part("PLAN_CLIENT", 842, 595), await part("AUTOCONTROLE")];
    const original = parts.map(item => Buffer.from(item.bytes));
    const result = await composeWorkshopPackPdf({ number: "OF-EXEMPLE", generatedAt: at, parts, ofMark: null });
    expect(result.manifest.map(item => [item.kind, item.first_page, item.page_count])).toEqual([["OF", 1, 1], ["PLAN_CLIENT", 2, 1], ["AUTOCONTROLE", 3, 1]]);
    const pdf = await PDFDocument.load(result.bytes);
    expect(pdf.getPageCount()).toBe(3); expect(pdf.getPage(1).getSize()).toEqual({ width: 842, height: 595 });
    const annotations = pdf.getPage(1).node.lookup(PDFName.of("Annots"), PDFArray);
    const note = pdf.context.lookup(annotations.get(0), PDFDict);
    expect(note.lookup(PDFName.of("Contents"), PDFString).decodeText()).toBe("Tolerance a conserver");
    expect(note.has(PDFName.of("A"))).toBe(false);
    parts.forEach((item, index) => expect(item.bytes.equals(original[index])).toBe(true));
  });
  it("produces stable original and duplicata bytes from the same frozen sources", async () => {
    const parts = [await part("OF"), await part("PLAN_CLIENT")], args = { number: "OF-EXEMPLE", generatedAt: at, parts };
    const original = await composeWorkshopPackPdf({ ...args, ofMark: null });
    const replay = await composeWorkshopPackPdf({ ...args, ofMark: null });
    const duplicate = await composeWorkshopPackPdf({ ...args, ofMark: "DUPLICATA" });
    const duplicateReplay = await composeWorkshopPackPdf({ ...args, ofMark: "DUPLICATA" });
    expect(replay.bytes.equals(original.bytes)).toBe(true);
    expect(duplicate.sha256).not.toBe(original.sha256); expect(duplicateReplay.bytes.equals(duplicate.bytes)).toBe(true);
    expect(duplicate.pages).toBe(original.pages);
  });
  it("refuses an altered attachment before producing a printable folder", async () => {
    const parts = [await part("OF"), { ...await part("PLAN_CLIENT"), sha256: "0".repeat(64) }];
    await expect(composeWorkshopPackPdf({ number: "OF-EXEMPLE", generatedAt: at, parts, ofMark: null })).rejects.toMatchObject({ code: "WORKSHOP_PACK_SOURCE_CHANGED" });
  });
  it("refuses a non-PDF plan and a folder without its OF", async () => {
    const bytes = Buffer.from("Non PDF");
    await expect(composeWorkshopPackPdf({ number: "OF-EXEMPLE", generatedAt: at, parts: [await part("OF"), { kind: "PLAN_CLIENT", name: "Plan client", bytes, sha256: hash(bytes) }], ofMark: null })).rejects.toMatchObject({ code: "WORKSHOP_PACK_SOURCE_UNREADABLE" });
    await expect(composeWorkshopPackPdf({ number: "OF-EXEMPLE", generatedAt: at, parts: [await part("PLAN_CLIENT")], ofMark: null })).rejects.toMatchObject({ code: "WORKSHOP_PACK_LIMIT" });
    const invalidImage = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
    await expect(composeWorkshopPackPdf({ number: "OF-EXEMPLE", generatedAt: at, parts: [await part("OF"), { kind: "PLAN_CLIENT", name: "Plan image", bytes: invalidImage, sha256: hash(invalidImage) }], ofMark: null })).rejects.toMatchObject({ code: "WORKSHOP_PACK_SOURCE_UNREADABLE" });
  });
  it("flattens filled form appearances only in the print copy", async () => {
    const source = await PDFDocument.create(); source.addPage([595, 842]);
    const field = source.getForm().createTextField("reference"); field.addToPage(source.getPage(0), { x: 50, y: 700, width: 200, height: 25 }); field.setText("REFERENCE-A");
    const bytes = Buffer.from(await source.save()), original = Buffer.from(bytes);
    const result = await composeWorkshopPackPdf({ number: "OF-EXEMPLE", generatedAt: at, parts: [{ kind: "OF", name: "OF", bytes, sha256: hash(bytes) }], ofMark: "BROUILLON" });
    expect((await PDFDocument.load(result.bytes)).getForm().getFields()).toHaveLength(0);
    expect(bytes.equals(original)).toBe(true);
    expect((await PDFDocument.load(bytes)).getForm().getTextField("reference").getText()).toBe("REFERENCE-A");
  });
  it("automatically prints a PNG plan without altering the approved image", async () => {
    const bytes = Buffer.from(CERP_LOGO_PNG), original = Buffer.from(bytes);
    const args = { number: "OF-EXEMPLE", generatedAt: at, parts: [await part("OF"), { kind: "PLAN_CLIENT", name: "Plan image", bytes, sha256: hash(bytes) }], ofMark: null };
    const result = await composeWorkshopPackPdf(args), replay = await composeWorkshopPackPdf(args);
    expect(result.pages).toBe(2); expect(result.bytes.equals(replay.bytes)).toBe(true); expect(bytes.equals(original)).toBe(true);
    const page = (await PDFDocument.load(result.bytes)).getPage(1);
    expect(page.getWidth()).toBeGreaterThan(page.getHeight());
  });
});
