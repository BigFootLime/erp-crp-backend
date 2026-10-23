import PDFDocument from "pdfkit"
import { documentFont } from "./document-fonts"

export type DocumentRaster = {
  bytes: Buffer
  caption: string
  reference?: string | null
}

type Colors = { ink: string; graphite: string; steel: string; hairline: string; wash: string; paper: string; brand: string }
type Geometry = { x: number; width: number; colors: Colors }
type SafeText = (text: string) => string

/** A bounded render copy. Plans and tool sketches are never cropped or fetched here. */
export function readableRaster(bytes: Buffer | null | undefined): Buffer | null {
  if (!bytes?.length || bytes.length > 8 * 1024 * 1024) return null
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8
  if (!png && !jpeg) return null
  if (png && (bytes.length < 24 || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 25_000_000)) return null
  // Decode before drawing any panel, so corrupt optional media cannot leave an empty frame.
  try {
    const ruler = new PDFDocument()
    const image = (ruler as PDFKit.PDFDocument & { openImage: (source: Buffer) => { width: number; height: number } }).openImage(bytes)
    if (!image.width || !image.height || image.width * image.height > 25_000_000) return null
    return bytes
  } catch { return null }
}

export function sectionHeight(doc: PDFKit.PDFDocument, title: string, width: number, safe: SafeText): number {
  doc.font(documentFont(doc, true)).fontSize(10.5)
  return Math.max(28, doc.heightOfString(safe(title), { width: width - 56 }) + 15)
}

/** Numbered, opaque section bands retain their hierarchy on a monochrome workshop printer. */
export function drawSectionBand(doc: PDFKit.PDFDocument, title: string, index: number, y: number, geometry: Geometry, safe: SafeText): number {
  const { x, width, colors: c } = geometry
  const height = sectionHeight(doc, title, width, safe)
  doc.save().rect(x, y, width, height).fill(c.wash).restore()
  doc.save().rect(x, y, 3, height).fill(c.brand).restore()
  doc.font(documentFont(doc, true)).fontSize(9).fillColor(c.steel)
  doc.text(String(index).padStart(2, "0"), x + 13, y + 9, { width: 25, lineBreak: false })
  doc.font(documentFont(doc, true)).fontSize(10.5).fillColor(c.ink)
  doc.text(safe(title), x + 43, y + 8, { width: width - 56 })
  return y + height + 10
}

export function operationHeadingHeight(doc: PDFKit.PDFDocument, title: string, width: number, safe: SafeText, number = ""): number {
  doc.font(documentFont(doc, true)).fontSize(13)
  const titleHeight = doc.heightOfString(safe(title), { width: width - 118 }) + 22
  doc.fontSize(19)
  if (doc.widthOfString(safe(number)) > 72) doc.fontSize(10)
  return Math.max(48, titleHeight, doc.heightOfString(safe(number), { width: 72 }) + 30)
}

/** Phase numbers stay beside their operation, rather than in a dense eight-column row. */
export function drawOperationHeading(doc: PDFKit.PDFDocument, operation: { number: string; title: string }, y: number, geometry: Geometry, safe: SafeText): number {
  const { x, width, colors: c } = geometry
  const height = operationHeadingHeight(doc, operation.title, width, safe, operation.number)
  doc.save().rect(x, y, width, height).fill(c.wash).restore()
  doc.save().rect(x, y, 92, height).fill(c.ink).restore()
  doc.font(documentFont(doc, true)).fontSize(8).fillColor(c.paper)
  doc.text("OPÉRATION", x + 10, y + 8, { width: 72, align: "center", lineBreak: false })
  const number = safe(operation.number)
  doc.fontSize(19)
  // Long historic phase identifiers remain complete; they are wrapped instead of clipped.
  if (doc.widthOfString(number) > 72) doc.fontSize(10)
  doc.text(number, x + 10, y + 21, { width: 72, align: "center" })
  doc.font(documentFont(doc, true)).fontSize(13).fillColor(c.ink)
  doc.text(safe(operation.title), x + 105, y + 11, { width: width - 118 })
  return y + height + 9
}

export function visualPanelHeight(doc: PDFKit.PDFDocument, visual: DocumentRaster, width: number, imageHeight: number, safe: SafeText): number {
  doc.font(documentFont(doc, true)).fontSize(9.5)
  const caption = doc.heightOfString(safe(visual.caption), { width: width - 24 })
  doc.font(documentFont(doc)).fontSize(8.5)
  const reference = visual.reference ? doc.heightOfString(safe(visual.reference), { width: width - 24 }) + 4 : 0
  return 12 + imageHeight + 10 + caption + reference + 12
}

/** Source labels identify the precise applicable plan/tool; image alone is never the reference. */
export function drawVisualPanel(doc: PDFKit.PDFDocument, visual: DocumentRaster, y: number, geometry: Geometry, imageHeight: number, safe: SafeText): number {
  const { x, width, colors: c } = geometry
  const height = visualPanelHeight(doc, visual, width, imageHeight, safe)
  doc.save().lineWidth(0.7).strokeColor(c.hairline).rect(x, y, width, height).stroke().restore()
  doc.image(visual.bytes, x + 12, y + 12, { fit: [width - 24, imageHeight], align: "center", valign: "center" })
  let textY = y + 12 + imageHeight + 10
  doc.font(documentFont(doc, true)).fontSize(9.5).fillColor(c.ink)
  doc.text(safe(visual.caption), x + 12, textY, { width: width - 24 })
  textY = doc.y + 4
  if (visual.reference) {
    doc.font(documentFont(doc)).fontSize(8.5).fillColor(c.steel)
    doc.text(safe(visual.reference), x + 12, textY, { width: width - 24 })
  }
  return y + height
}
