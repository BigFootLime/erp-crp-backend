import { INTER_REGULAR, INTER_BOLD } from "./cerp-inter-fonts";

const interDocuments = new WeakSet<PDFKit.PDFDocument>();

/** Opt-in is local to one PDF, including its measuring ruler. */
export function registerInterDocumentFonts(doc: PDFKit.PDFDocument): void {
  doc.registerFont("CERP-Inter-Regular", INTER_REGULAR);
  doc.registerFont("CERP-Inter-Bold", INTER_BOLD);
  // Module blocks still using the historic names use these document-local
  // aliases too; no process-wide font state is changed.
  doc.registerFont("Helvetica", INTER_REGULAR);
  doc.registerFont("Helvetica-Bold", INTER_BOLD);
  doc.registerFont("Helvetica-Oblique", INTER_REGULAR);
  interDocuments.add(doc);
  doc.font(documentFont(doc));
}

export function documentFont(doc: PDFKit.PDFDocument, bold = false): string {
  return interDocuments.has(doc)
    ? (bold ? "CERP-Inter-Bold" : "CERP-Inter-Regular")
    : (bold ? "Helvetica-Bold" : "Helvetica");
}
