import type { CerpDocumentHeader } from "./cerp-document"
import { CERP_LOGO_PNG, CERP_LOGO_RATIO } from "./cerp-logo"
import { readableRaster } from "./editorial-document-blocks"

export type CerpDocumentDesign = "classic-v1" | "editorial-v2" | "workshop-v3" | "workshop-v4" | "structured-v5"

/** Per-document metrics: concurrent renders never change global typography. */
export const DOCUMENT_DESIGNS = {
  "classic-v1": { body: 9.5, tableHeading: 6.9, tableMeta: 7.6, tableHeadHeight: 16 },
  "editorial-v2": { body: 10.2, tableHeading: 8, tableMeta: 8.4, tableHeadHeight: 23 },
  "workshop-v3": { body: 10.5, tableHeading: 8.5, tableMeta: 9, tableHeadHeight: 25 },
  "workshop-v4": { body: 10.5, tableHeading: 8.5, tableMeta: 9, tableHeadHeight: 25 },
  "structured-v5": { body: 10.5, tableHeading: 8.5, tableMeta: 9, tableHeadHeight: 25 },
} as const

type HeaderGeometry = {
  marginX: number
  marginTop: number
  width: number
  colors: { brand: string; ink: string; graphite: string; steel: string; hairline: string; wash: string; paper: string }
}

/** Editorial identity; only images already resolved by the authorized caller are accepted. */
export function drawEditorialDocumentHeader(
  doc: PDFKit.PDFDocument,
  header: CerpDocumentHeader,
  geometry: HeaderGeometry,
  safeText: (value: string) => string,
): number {
  const { marginX: x, marginTop: top, width, colors: c } = geometry
  const logoWidth = 122
  const logoHeight = logoWidth / CERP_LOGO_RATIO
  doc.image(CERP_LOGO_PNG, x, top, { width: logoWidth })
  doc.font("Helvetica-Bold").fontSize(10).fillColor(c.brand)
  const typeWidth = width - logoWidth - 32
  const type = safeText(header.documentType.toUpperCase())
  doc.text(type, x + logoWidth + 32, top + 10, { width: typeWidth, align: "right", characterSpacing: 1 })
  const mastheadBottom = Math.max(top + logoHeight, doc.y)
  doc.save().lineWidth(0.6).strokeColor(c.hairline)
  doc.moveTo(x, mastheadBottom + 13).lineTo(x + width, mastheadBottom + 13).stroke().restore()
  doc.save().rect(x, mastheadBottom + 12, 44, 2).fill(c.brand).restore()

  const identityTop = mastheadBottom + 30
  const entityImage = readableRaster(header.entityImage)
  const slotWidth = entityImage ? 94 : 0
  const mainWidth = width - (slotWidth ? slotWidth + 20 : 0)
  doc.font("Helvetica-Bold").fontSize(27).fillColor(c.ink)
  doc.text(safeText(header.name), x, identityTop, { width: mainWidth })
  let y = doc.y + 9

  // The reference remains prominent, but is not printed twice under itself.
  if (!header.code || header.code.trim() !== header.name.trim()) {
    doc.font("Helvetica-Bold").fontSize(10.2).fillColor(c.graphite)
    doc.text(safeText(header.code ?? "Code non attribué"), x, y, { width: mainWidth })
    y = doc.y + 8
  }
  const status = safeText(header.status)
  doc.font("Helvetica-Bold").fontSize(8.5)
  const statusWidth = Math.min(mainWidth, doc.widthOfString(status) + 18)
  const statusHeight = Math.max(20, doc.heightOfString(status, { width: Math.max(statusWidth - 18, 1) }) + 10)
  doc.save().roundedRect(x, y, statusWidth, statusHeight, 3).fill(c.wash).restore()
  doc.fillColor(c.graphite).text(status, x + 9, y + 5, { width: Math.max(statusWidth - 18, 1) })
  y += statusHeight + 8
  if (header.flag?.trim()) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(c.brand)
    doc.text(safeText(header.flag), x, y, { width: mainWidth })
    y = doc.y + 7
  }
  if (header.subtitle?.trim()) {
    doc.font("Helvetica").fontSize(8.6).fillColor(c.steel)
    doc.text(safeText(header.subtitle), x, y, { width: mainWidth })
    y = doc.y + 3
  }
  if (entityImage) {
    try {
      doc.image(entityImage, x + width - slotWidth, identityTop + 2, { fit: [slotWidth, 70], align: "center", valign: "center" })
      y = Math.max(y, identityTop + 72)
    } catch { /* Keep the document's identity and business content if the optional raster is unsupported. */ }
  }
  doc.fillColor(c.ink)
  return y + 8
}

function runningHeadText(header: CerpDocumentHeader): string {
  return header.code && header.code.trim() !== header.name.trim() ? `${header.name} — ${header.code}` : header.name
}

/** Longer references enlarge the repeat header reserve rather than overlap the first operation. */
export function editorialPageTop(doc: PDFKit.PDFDocument, header: CerpDocumentHeader, width: number, safe: (value: string) => string): number {
  doc.font("Helvetica-Bold").fontSize(7)
  const left = doc.heightOfString(safe(header.documentType.toUpperCase()), { width: width * 0.58, characterSpacing: 0.6 })
  doc.font("Helvetica").fontSize(7.5)
  const right = doc.heightOfString(safe(runningHeadText(header)), { width: width * 0.38 })
  return Math.max(34, 6 + Math.max(left, right) + 12)
}

export function drawEditorialRunningHead(doc: PDFKit.PDFDocument, header: CerpDocumentHeader, geometry: HeaderGeometry, safe: (value: string) => string): void {
  const {marginX:x,width,colors:c}=geometry
  const top=editorialPageTop(doc,header,width,safe)
  doc.font("Helvetica-Bold").fontSize(7).fillColor(c.brand)
  doc.text(safe(header.documentType.toUpperCase()),x,6,{width:width*0.58,characterSpacing:0.6})
  doc.font("Helvetica").fontSize(7.5).fillColor(c.steel)
  doc.text(safe(runningHeadText(header)),x+width*0.62,6,{width:width*0.38,align:"right"})
  doc.save().lineWidth(0.6).strokeColor(c.hairline).moveTo(x,top-7).lineTo(x+width,top-7).stroke().restore()
}
