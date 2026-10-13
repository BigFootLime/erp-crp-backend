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
  columns?: 1 | 2
  columnWeights?: readonly [number, number]
  fields: ReadonlyArray<{ label: string; value: string | null; prominent?: boolean; span?: 2 }>
}

/** Bordered business zones: labels and their values stay together, with measured wrapping. */
export function renderWorkshopBoxes(ctx: CerpDocumentContext, boxes: readonly WorkshopFieldBox[], options: { compact?: boolean } = {}): void {
  if (!boxes.length) return
  // The first-page cartouches must leave clearance around the horizontal A4 fold.
  // Keep the full-size table typography for routing instructions on later pages.
  const pad = options.compact ? 6 : PAD
  const gap = options.compact ? 8 : 12
  const body = options.compact ? 10 : BODY
  const labelSize = options.compact ? 8 : 8.5
  const labelLeading = options.compact ? 9.5 : 11
  const valueLeading = options.compact ? 12 : LEADING
  const prominentSize = options.compact ? 13 : 14
  const prominentLeading = options.compact ? 15 : 17
  const fieldGap = options.compact ? 2 : 3
  const rowGap = options.compact ? 5 : 12
  const width = (CONTENT_WIDTH - gap * (boxes.length - 1)) / boxes.length
  const measured = boxes.map(box => {
    const columns = box.columns ?? 1
    const weights = columns === 2 ? box.columnWeights ?? [1, 1] : [1]
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
    const fieldWidths = weights.map(weight => (width - pad * 2 - (columns - 1) * gap) * weight / totalWeight)
    let occupiedColumn = 0
    const fields = box.fields.map(field => {
      const span = columns === 2 && field.span === 2 ? 2 : 1
      if (occupiedColumn + span > columns) occupiedColumn = 0
      const textWidth = span === 2 ? width - pad * 2 : fieldWidths[occupiedColumn]
      occupiedColumn = (occupiedColumn + span) % columns
      return {
        ...field, span, textWidth,
        label: wrappedLines(ctx.doc, field.label, textWidth, false, labelSize),
        value: wrappedLines(ctx.doc, field.value?.trim() || "Non renseigné", textWidth, true, field.prominent ? prominentSize : body),
      }
    })
    const rows: Array<typeof fields> = []
    let row: typeof fields = [], occupied = 0
    for (const field of fields) {
      if (occupied + field.span > columns) { rows.push(row); row = []; occupied = 0 }
      row.push(field); occupied += field.span
      if (occupied === columns) { rows.push(row); row = []; occupied = 0 }
    }
    if (row.length) rows.push(row)
    return { box, rows, fieldWidths, title: wrappedLines(ctx.doc, box.title.toUpperCase(), width - pad * 2, true, 10) }
  })
  const headingPad = options.compact ? 5 : 6
  const headingHeight = Math.max(...measured.map(item => item.title.length * 12)) + headingPad * 2
  const rowHeight = (fields: typeof measured[number]["rows"][number]) => Math.max(...fields.map(field => field.label.length * labelLeading)) + fieldGap
    + Math.max(...fields.map(field => field.value.length * (field.prominent ? prominentLeading : valueLeading))) + rowGap
  const heights = measured.map(item => {
    let height = headingHeight + pad
    for (const row of item.rows) height += rowHeight(row)
    return height
  })
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
    item.title.forEach((line, i) => ctx.text(line, x + pad, top + headingPad + i * 12, { width: width - pad * 2 }))
    ctx.doc.save().lineWidth(0.8).strokeColor(C.graphite).rect(x, top, width, height).stroke().restore()
    let y = top + headingHeight + pad
    const columns = item.box.columns ?? 1
    const dividerX = x + pad + item.fieldWidths[0] + gap / 2
    for (const row of item.rows) {
    // Full-width references and document lists have no divider running through their text.
    if (columns === 2 && row.every(field => field.span === 1)) {
      ctx.doc.save().lineWidth(0.5).strokeColor(C.hairline).moveTo(dividerX, y).lineTo(dividerX, y + rowHeight(row) - rowGap).stroke().restore()
    }
    let column = 0
    row.forEach(field => {
      const fieldX = x + pad + item.fieldWidths.slice(0, column).reduce((sum, size) => sum + size, 0) + column * gap
      ctx.doc.font("Helvetica").fontSize(labelSize).fillColor(C.graphite)
      field.label.forEach((line, i) => ctx.text(line, fieldX, y + i * labelLeading, { width: field.textWidth }))
      const valueY = y + Math.max(...row.map(item => item.label.length * labelLeading)) + fieldGap
      ctx.doc.font("Helvetica-Bold").fontSize(field.prominent ? prominentSize : body).fillColor(C.ink)
      field.value.forEach((line, i) => ctx.text(line, fieldX, valueY + i * (field.prominent ? prominentLeading : valueLeading), { width: field.textWidth }))
      column += field.span
    })
    y += rowHeight(row)
    }
  })
  ctx.y = top + height + gap
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
  const compactHeight = headHeight + cells.reduce((sum, row) => sum + Math.max(...row.map(lines => lines.length)) * LEADING + PAD * 2, 0)
  // Keep short summaries together rather than stranding their last total on a new page.
  if (rows.length <= 8 && compactHeight <= 320 && compactHeight + titleReserve < freshCapacity)
    ctx.ensureSpace(compactHeight + titleReserve + 10)
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
