import type { CerpDocumentHeader } from "./cerp-document"
import { CERP_LOGO_PNG, CERP_LOGO_RATIO } from "./cerp-logo"
import { readableRaster } from "./editorial-document-blocks"
import { documentFont } from "./document-fonts"
import { PDF_MODULE_ACCENTS } from "./document-theme"

/** Workshop identity has a clear document title and reference, without a page-count target. */
export function drawWorkshopDocumentHeader(
  doc: PDFKit.PDFDocument,
  header: CerpDocumentHeader,
  geometry: { marginX: number; marginTop: number; width: number },
  safe: (value: string) => string,
): number {
  const { marginX: x, marginTop: y, width } = geometry
  const logoWidth = 105
  doc.image(CERP_LOGO_PNG, x, y, { width: logoWidth })
  const clientImage = header.appearance === "clients-v3" || header.appearance === "module-v1" ? readableRaster(header.entityImage) : null
  if (clientImage) {
    doc.image(clientImage, x + width - 105, y, { fit: [105, 64], align: "center", valign: "center" })
  }
  const sideWidth = 120
  const textX = x + sideWidth
  const textWidth = width - sideWidth * 2
  doc.font(documentFont(doc, true)).fontSize(17).fillColor("#101418")
  doc.text(safe(header.documentType.toUpperCase()), textX, y + 1, { width: textWidth, align: "center" })
  let bottom = doc.y + 5
  doc.font(documentFont(doc, true)).fontSize(18).fillColor(header.appearance === "module-v1" ? PDF_MODULE_ACCENTS[header.module ?? "commerce"] : header.appearance === "clients-v3" ? "#2563eb" : "#B90101")
  doc.text(safe(header.name), textX, bottom, { width: textWidth, align: "center" })
  bottom = Math.max(doc.y + 10, y + logoWidth / CERP_LOGO_RATIO + 10)
  if (clientImage) bottom = Math.max(bottom, y + 74)
  if (header.designVersion !== "workshop-v4" && header.designVersion !== "structured-v5") {
    doc.font(documentFont(doc)).fontSize(9).fillColor("#3D444C")
    doc.text(safe(`Édité le\n${header.generatedAt}`), x + width - 105, y + 3, { width: 105, align: "right" })
    bottom = Math.max(bottom, doc.y + 10)
  }
  doc.save().lineWidth(1.1).strokeColor("#3D444C")
  doc.moveTo(x, bottom).lineTo(x + width, bottom).stroke().restore()
  // The shared form design is also used outside production. Archived workshop
  // editions retain their original wording and geometry.
  const state = header.designVersion === "structured-v5"
    ? [header.code && header.code !== header.name ? header.code : null, header.status, header.flag].filter(Boolean).join("  |  ")
    : [header.code, `Fabrication : ${header.status}`, header.flag].filter(Boolean).join("  |  ")
  doc.font(documentFont(doc, true)).fontSize(9).fillColor("#3D444C")
  doc.text(safe(state), x, bottom + 8, { width })
  if (header.appearance === "module-v1" && header.subtitle?.trim()) {
    doc.font(documentFont(doc)).fontSize(8.5).fillColor("#435d73")
    doc.text(safe(header.subtitle), x, doc.y + 4, { width })
  }
  return doc.y + 16
}
