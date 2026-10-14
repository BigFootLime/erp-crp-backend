import { createHash } from "node:crypto";
import { degrees, PDFArray, PDFDict, PDFDocument, PDFName, rgb, StandardFonts } from "pdf-lib";
import PDFKitDocument from "pdfkit";
import { HttpError } from "../../../utils/httpError";
import type { WorkshopCopyMark } from "../domain/workshop-print-policy";

export type WorkshopPdfPart = { kind: string; name: string; bytes: Buffer; sha256: string };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The operator plan viewer already accepts PNG/JPEG. Convert those exact
 * approved image bytes automatically, including JPEG EXIF orientation. */
async function imagePlanPdf(bytes: Buffer, date: Date): Promise<Buffer> {
  const doc = new PDFKitDocument({ autoFirstPage: false, margin: 0, info: { CreationDate: date, ModDate: date, Creator: "CERP", Producer: "CERP" } });
  const chunks: Buffer[] = [];
  const output = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", chunk => chunks.push(Buffer.from(chunk))); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);
  });
  // PDFKit exposes image inspection at runtime; its public TS definitions omit
  // this method. Keep that adaptation local and pinned to the existing runtime.
  try {
    const image = (doc as PDFKit.PDFDocument & { openImage(data: Buffer): { width: number; height: number; orientation?: number } }).openImage(bytes);
    if (!Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0
      || image.width * image.height > 40_000_000) throw new Error("PLAN_IMAGE_DIMENSIONS_INVALID");
    const swapped = (image.orientation ?? 1) > 4;
    const landscape = swapped ? image.height > image.width : image.width > image.height;
    doc.addPage({ size: "A4", layout: landscape ? "landscape" : "portrait", margin: 0 });
    // EXIF orientation is respected by default in the installed PDFKit runtime.
    doc.image(bytes, 0, 0, { fit: [doc.page.width, doc.page.height], align: "center", valign: "center" });
    doc.end(); return output;
  } catch (error) {
    doc.end(); await output.catch(() => undefined); throw error;
  }
}

/** Print copies only. Sources remain immutable, and the rendered OF is never
 * reconstructed from today's data merely to add a duplicata mark. */
export async function composeWorkshopPackPdf(args: {
  number: string; generatedAt: string; parts: readonly WorkshopPdfPart[]; ofMark: WorkshopCopyMark;
}) {
  const date = new Date(args.generatedAt);
  if (Number.isNaN(date.getTime()) || !args.parts.length || args.parts.length > 40
    || ![null, "BROUILLON", "DUPLICATA", "OBSOLETE"].includes(args.ofMark)
    || args.parts[0].kind !== "OF" || args.parts.filter(part => part.kind === "OF").length !== 1
    || args.parts.reduce((sum, part) => sum + part.bytes.length, 0) > 50 * 1024 * 1024) {
    throw new HttpError(422, "WORKSHOP_PACK_LIMIT", "Le dossier doit être préparé avant impression.");
  }
  const output = await PDFDocument.create();
  output.setTitle(`Dossier de fabrication ${args.number}`); output.setAuthor("Croix Rousse Precision");
  output.setCreator("CERP"); output.setProducer("CERP"); output.setCreationDate(date); output.setModificationDate(date);
  const font = await output.embedFont(StandardFonts.HelveticaBold);
  const manifest: Array<{ kind: string; name: string; sha256: string; first_page: number; page_count: number }> = [];
  let total = 0;
  for (const part of args.parts) {
    if (!part.bytes.length || digest(part.bytes) !== part.sha256) {
      throw new HttpError(409, "WORKSHOP_PACK_SOURCE_CHANGED", "Un document du dossier ne correspond plus à son édition enregistrée.");
    }
    let source: PDFDocument;
    try {
      const image = part.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || (part.bytes[0] === 255 && part.bytes[1] === 216 && part.bytes[2] === 255);
      if (image && !["PLAN_CLIENT", "PLAN_FABRICATION"].includes(part.kind)) throw new Error("EXPECTED_GENERATED_PDF");
      source = await PDFDocument.load(image ? await imagePlanPdf(part.bytes, date) : part.bytes, { updateMetadata: false });
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new HttpError(503, "WORKSHOP_RENDER_UNAVAILABLE", "Le service d'impression est temporairement indisponible. Réessayez.");
      throw new HttpError(422, "WORKSHOP_PACK_SOURCE_UNREADABLE", `Le document « ${part.name} » doit être fourni en PDF, PNG ou JPEG imprimable.`);
    }
    const count = source.getPageCount();
    if (!count || total + count > 200) throw new HttpError(422, "WORKSHOP_PACK_LIMIT", "Le dossier dépasse 200 pages ; vérifiez ses documents.");
    // Flatten a private copy so filled paper forms retain their visible values.
    // Neither the original AcroForm nor the archived bytes are edited.
    const form = source.getForm();
    if (form.hasXFA()) throw new HttpError(422, "WORKSHOP_PACK_SOURCE_UNREADABLE", `Le document « ${part.name} » doit être converti en PDF standard.`);
    if (form.getFields().length) form.flatten({ updateFieldAppearances: false });
    const pages = await output.copyPages(source, source.getPageIndices());
    for (const page of pages) {
      // Retain visible plan notes and annotation appearances. Remove actions,
      // not annotations: deleting them would hide engineering information.
      const annotations = page.node.get(PDFName.of("Annots"));
      if (annotations) {
        const array = output.context.lookup(annotations);
        if (array instanceof PDFArray) for (const ref of array.asArray()) {
          const annotation = output.context.lookup(ref);
          if (annotation instanceof PDFDict) { annotation.delete(PDFName.of("A")); annotation.delete(PDFName.of("AA")); }
        }
      }
      output.addPage(page);
      if (part.kind === "OF" && args.ofMark) {
        const { width, height } = page.getSize(), angle = Math.atan2(height, width) * 180 / Math.PI;
        const size = Math.min(66, width * .12), textWidth = font.widthOfTextAtSize(args.ofMark, size);
        page.drawText(args.ofMark, { font, size, color: rgb(.72, .08, .08), opacity: .12, rotate: degrees(angle),
          x: width / 2 - Math.cos(angle * Math.PI / 180) * textWidth / 2,
          y: height / 2 - Math.sin(angle * Math.PI / 180) * textWidth / 2 });
      }
    }
    manifest.push({ kind: part.kind, name: part.name, sha256: part.sha256, first_page: total + 1, page_count: count });
    total += count;
  }
  const bytes = Buffer.from(await output.save({ useObjectStreams: false, addDefaultPage: false }));
  return { bytes, sha256: digest(bytes), pages: total, manifest };
}
