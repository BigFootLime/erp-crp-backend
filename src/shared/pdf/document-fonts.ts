import { INTER_REGULAR, INTER_BOLD } from "./cerp-inter-fonts";

const interDocuments = new WeakSet<PDFKit.PDFDocument>();

/** Opt-in is local to one PDF, including its measuring ruler. */
export function registerInterDocumentFonts(doc: PDFKit.PDFDocument): void {
  doc.registerFont("CERP-Inter-Regular", INTER_REGULAR);
  doc.registerFont("CERP-Inter-Bold", INTER_BOLD);
  interDocuments.add(doc);
  doc.font(documentFont(doc));
}

export function documentFont(doc: PDFKit.PDFDocument, bold = false): string {
  return interDocuments.has(doc)
    ? (bold ? "CERP-Inter-Bold" : "CERP-Inter-Regular")
    : (bold ? "Helvetica-Bold" : "Helvetica");
}
