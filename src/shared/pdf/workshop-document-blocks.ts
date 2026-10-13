import { CERP_DOC_COLORS as C, CONTENT_WIDTH, toPdfSafeText, type CerpDocumentContext } from "./cerp-document"
import { sectionHeight } from "./editorial-document-blocks"

const X = 38
const PAD = 9
const BODY = 10.5
const LEADING = 13.8

/** Deterministic line wrapping; long identifiers and explicit paragraphs are retained in full. */
function wrappedLines(doc: PDFKit.PDFDocument, text: string, width: number, bold = false, size = BODY): string[] {
  doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size)
  const lines: string[] = []
  for (const paragraph of toPdfSafeText(text).split(/\r?\n/)) {
    let line = ""
    const words = paragraph.trim().split(/\s+/).filter(Boolean)
    if (!words.length) { lines.push(""); continue }
    for (const word of words) {
      if (line && doc.widthOfString(`${line} ${word}`) <= width) { line += ` ${word}`; continue }
      if (line) { lines.push(line); line = "" }
      for (const char of word) {
        if (line && doc.widthOfString(line + char) > width) { lines.push(line); line = "" }
        line += char
      }
    }
    if (line) lines.push(line)
  }
  return lines.length ? lines : [""]
}

export type WorkshopFieldBox = {
  title: string
  fields: ReadonlyArray<{ label: string; value: string | null; prominent?: boolean }>
}

/** Bordered business zones: labels and their values stay together, with measured wrapping. */
export function renderWorkshopBoxes(ctx: CerpDocumentContext, boxes: readonly WorkshopFieldBox[]): void {
  if (!boxes.length) return
  const gap = 12
  const width = (CONTENT_WIDTH - gap * (boxes.length - 1)) / boxes.length
  const measured = boxes.map(box => ({
    box,
    title: wrappedLines(ctx.doc, box.title.toUpperCase(), width - PAD * 2, true, 10),
    fields: box.fields.map(field => ({
      ...field,
      label: wrappedLines(ctx.doc, field.label, width - PAD * 2, false, 8.5),
      value: wrappedLines(ctx.doc, field.value?.trim() || "Non renseigné", width - PAD * 2, true, field.prominent ? 14 : BODY),
    })),
  }))
  const headingHeight = Math.max(...measured.map(item => item.title.length * 12)) + PAD * 2
  const heights = measured.map(item => headingHeight + PAD + item.fields.reduce((sum, field) =>
    sum + field.label.length * 11 + 3 + field.value.length * (field.prominent ? 17 : LEADING) + 12, 0))
  const height = Math.max(...heights)
  if (height > ctx.contentBottom - ctx.pageContentTop - 50) {
    // An unusually long field is not shrunk or truncated to squeeze into a box.
    for (const box of boxes) renderWorkshopTable(ctx, {
      title: box.title,
      columns: [{ key: "label", label: "Information", flex: 1 }, { key: "value", label: "Valeur", flex: 3 }],
      rows: box.fields.map(field => ({ cells: { label: field.label, value: field.value || "Non renseigné" } })),
    })
    return
  }
  ctx.ensureSpace(height + 10)
  const top = ctx.y
  measured.forEach((item, index) => {
    const x = X + index * (width + gap)
    ctx.doc.save().rect(x, top, width, headingHeight).fill(C.graphite).restore()
    ctx.doc.font("Helvetica-Bold").fontSize(10).fillColor(C.paper)
    item.title.forEach((line, i) => ctx.text(line, x + PAD, top + PAD + i * 12, { width: width - PAD * 2 }))
    ctx.doc.save().lineWidth(0.8).strokeColor(C.graphite).rect(x, top, width, height).stroke().restore()
    let y = top + headingHeight + PAD
    for (const field of item.fields) {
      ctx.doc.font("Helvetica").fontSize(8.5).fillColor(C.graphite)
      field.label.forEach((line, i) => ctx.text(line, x + PAD, y + i * 11, { width: width - PAD * 2 }))
      y += field.label.length * 11 + 3
      ctx.doc.font("Helvetica-Bold").fontSize(field.prominent ? 14 : BODY).fillColor(C.ink)
      field.value.forEach((line, i) => ctx.text(line, x + PAD, y + i * (field.prominent ? 17 : LEADING), { width: width - PAD * 2 }))
      y += field.value.length * (field.prominent ? 17 : LEADING) + 12
    }
  })
  ctx.y = top + height + 12
}

export type WorkshopTableColumn = { key: string; label: string; flex: number; bold?: boolean; firstLineBold?: boolean; align?: "left" | "right" }
export type WorkshopTableRow = { cells: Record<string, string>; continuationLabel?: string }

/** Full grid, repeated headings and explicit continuation for a row longer than an entire page. */
export function renderWorkshopTable(ctx: CerpDocumentContext, table: {
  title?: string
  columns: readonly WorkshopTableColumn[]
  rows: readonly WorkshopTableRow[]
  emptyLabel?: string
}): void {
  const { columns, rows } = table
  if (!columns.length) return
  const flex = columns.reduce((sum, column) => sum + column.flex, 0)
  const widths = columns.map(column => CONTENT_WIDTH * column.flex / flex)
  const positions = widths.map((_, i) => X + widths.slice(0, i).reduce((sum, width) => sum + width, 0))
  const head = columns.map((column, i) => wrappedLines(ctx.doc, column.label, widths[i] - PAD * 2, true, 8.5))
  const headHeight = Math.max(...head.map(lines => lines.length)) * 11 + PAD * 2
  const cells = rows.map(row => columns.map((column, i) => wrappedLines(ctx.doc, row.cells[column.key] ?? "", widths[i] - PAD * 2, column.bold || column.firstLineBold)))
  const freshCapacity = ctx.contentBottom - ctx.pageContentTop - headHeight - 8
  const firstHeight = cells[0] ? Math.max(...cells[0].map(lines => lines.length)) * LEADING + PAD * 2 : 30
  const titleReserve = table.title ? sectionHeight(ctx.doc, table.title, CONTENT_WIDTH, toPdfSafeText) + 10 : 0
  const firstMustSplit = firstHeight > freshCapacity - titleReserve - 10
  const firstReserve = firstMustSplit ? PAD * 2 + LEADING * 3 : firstHeight
  if (table.title) ctx.section(table.title, { cohesion: headHeight + firstReserve + 10 })
  if (!rows.length) { ctx.notes(table.emptyLabel ?? "Aucune donnée enregistrée."); return }

  const grid = (top: number, height: number, background?: string) => {
    if (background) ctx.doc.save().rect(X, top, CONTENT_WIDTH, height).fill(background).restore()
    ctx.doc.save().lineWidth(0.65).strokeColor(C.graphite).rect(X, top, CONTENT_WIDTH, height).stroke()
    positions.slice(1).forEach(x => ctx.doc.moveTo(x, top).lineTo(x, top + height).stroke())
    ctx.doc.restore()
  }
  const drawHead = () => {
    grid(ctx.y, headHeight, C.wash)
    ctx.doc.font("Helvetica-Bold").fontSize(8.5).fillColor(C.graphite)
    head.forEach((lines, index) => lines.forEach((line, i) => ctx.text(line, positions[index] + PAD, ctx.y + PAD + i * 11,
      { width: widths[index] - PAD * 2, align: columns[index].align ?? "left" })))
    ctx.y += headHeight
  }
  ctx.ensureSpace(headHeight + firstReserve + 10)
  drawHead()
  rows.forEach((row, rowIndex) => {
    const lines = cells[rowIndex]
    const count = Math.max(...lines.map(cell => cell.length))
    const fullHeight = count * LEADING + PAD * 2
    if (!(rowIndex === 0 && firstMustSplit) && fullHeight <= freshCapacity && ctx.y + fullHeight + 8 > ctx.contentBottom) { ctx.newPage(); drawHead() }
    let offset = 0
    while (offset < count) {
      if (ctx.y + PAD * 2 + LEADING + 8 > ctx.contentBottom) { ctx.newPage(); drawHead() }
      if (offset > 0) {
        ctx.doc.font("Helvetica-Bold").fontSize(9).fillColor(C.graphite)
        ctx.text(row.continuationLabel ?? "Suite de la ligne", X + PAD, ctx.y + 4, { width: CONTENT_WIDTH - PAD * 2 })
        ctx.y += 20
      }
      const capacity = Math.max(1, Math.floor((ctx.contentBottom - ctx.y - PAD * 2 - 8) / LEADING))
      const chunk = Math.min(count - offset, capacity)
      const height = chunk * LEADING + PAD * 2
      grid(ctx.y, height)
      columns.forEach((column, index) => {
        lines[index].slice(offset, offset + chunk).forEach((line, i) => {
          ctx.doc.font(column.bold || (column.firstLineBold && offset + i === 0) ? "Helvetica-Bold" : "Helvetica").fontSize(BODY).fillColor(C.ink)
          ctx.text(line, positions[index] + PAD, ctx.y + PAD + i * LEADING, { width: widths[index] - PAD * 2, align: column.align ?? "left" })
        })
      })
      ctx.y += height
      offset += chunk
      if (offset < count) { ctx.newPage(); drawHead() }
    }
  })
  ctx.y += 12
}
