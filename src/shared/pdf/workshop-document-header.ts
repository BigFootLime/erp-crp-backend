import type { CerpDocumentHeader } from "./cerp-document"
import { CERP_LOGO_PNG, CERP_LOGO_RATIO } from "./cerp-logo"

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
  const sideWidth = 120
  const textX = x + sideWidth
  const textWidth = width - sideWidth * 2
  doc.font("Helvetica-Bold").fontSize(17).fillColor("#101418")
  doc.text(safe(header.documentType.toUpperCase()), textX, y + 1, { width: textWidth, align: "center" })
  let bottom = doc.y + 5
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#B90101")
  doc.text(safe(header.name), textX, bottom, { width: textWidth, align: "center" })
  bottom = Math.max(doc.y + 10, y + logoWidth / CERP_LOGO_RATIO + 10)
  if (header.designVersion !== "workshop-v4" && header.designVersion !== "structured-v5") {
    doc.font("Helvetica").fontSize(9).fillColor("#3D444C")
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
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#3D444C")
  doc.text(safe(state), x, bottom + 8, { width })
  return doc.y + 16
}
