import PDFDocument from "pdfkit"

import pool from "../../../config/database"

import type { LivraisonPackPreview } from "../types/pack.types"

function formatDateFR(iso: string | null | undefined): string {
  if (!iso) return "-"
  const raw = String(iso)
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[3]}/${m[2]}/${m[1]}`

  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  const dd = String(d.getDate()).padStart(2, "0")
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const yyyy = d.getFullYear()
  return `${dd}/${mm}/${yyyy}`
}

async function getCompanyHeader(): Promise<string | null> {
  const res = await pool.query<{ biller_name: string }>(`SELECT biller_name FROM factureur ORDER BY biller_id ASC LIMIT 1`)
  const name = res.rows[0]?.biller_name
  return typeof name === "string" && name.trim() ? name.trim() : null
}

function toUtcMidnightFromIso(iso: string | null | undefined): Date {
  const raw = typeof iso === "string" ? iso : ""
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) {
    const yyyy = Number(m[1])
    const mm = Number(m[2]) - 1
    const dd = Number(m[3])
    if (Number.isFinite(yyyy) && Number.isFinite(mm) && Number.isFinite(dd)) {
      return new Date(Date.UTC(yyyy, mm, dd, 0, 0, 0))
    }
  }

  const d = new Date(raw)
  if (!Number.isNaN(d.getTime())) return d
  return new Date("1970-01-01T00:00:00.000Z")
}

async function renderPdfToBuffer(args: { creationDate: Date; render: (doc: PDFKit.PDFDocument) => void }): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 40, info: { CreationDate: args.creationDate } })
  const chunks: Buffer[] = []
  doc.on("data", (c) => chunks.push(c as Buffer))
  args.render(doc)
  doc.end()

  await new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve())
    doc.on("error", (err) => reject(err))
  })

  return Buffer.concat(chunks)
}

function drawKeyValue(doc: PDFKit.PDFDocument, key: string, value: string) {
  doc.font("Helvetica-Bold").text(key, { continued: true })
  doc.font("Helvetica").text(` ${value}`)
}

function renderBlLinesTable(
  doc: PDFKit.PDFDocument,
  args: {
    lines: Array<{
      ordre: number
      designation: string
      code_piece: string | null
      quantite: number
      unite: string | null
      delai_client: string | null
    }>
    startY: number
    pageNoStart: number
  }
): { y: number; pageNo: number } {
  const marginX = doc.page.margins.left
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right
  const maxY = doc.page.height - doc.page.margins.bottom - 90
  const widths = {
    ordre: 28,
    designation: Math.max(220, pageWidth - (28 + 90 + 70 + 70 + 70)),
    code_piece: 90,
    quantite: 70,
    unite: 70,
    delai: 70,
  }

  let y = args.startY
  let pageNo = args.pageNoStart

  const renderHeader = () => {
    doc.fontSize(9).fillColor("#111111").font("Helvetica-Bold")
    doc.text("N°", marginX, y, { width: widths.ordre })
    doc.text("Designation", marginX + widths.ordre, y, { width: widths.designation })
    doc.text("Code piece", marginX + widths.ordre + widths.designation, y, { width: widths.code_piece })
    doc.text("Qte", marginX + widths.ordre + widths.designation + widths.code_piece, y, { width: widths.quantite, align: "right" })
    doc.text(
      "Unite",
      marginX + widths.ordre + widths.designation + widths.code_piece + widths.quantite,
      y,
      { width: widths.unite, align: "right" }
    )
    doc.text(
      "Delai",
      marginX + widths.ordre + widths.designation + widths.code_piece + widths.quantite + widths.unite,
      y,
      { width: widths.delai, align: "right" }
    )
    doc.moveTo(marginX, y + 14).lineTo(marginX + pageWidth, y + 14).strokeColor("#e5e7eb").stroke()
    doc.font("Helvetica").fillColor("#111111")
  }

  const renderFooter = () => {
    const bottomY = doc.page.height - doc.page.margins.bottom + 20
    doc.fontSize(9).fillColor("#6b7280").font("Helvetica")
    doc.text(`Page ${pageNo}`, marginX, bottomY, { width: pageWidth, align: "right" })
    doc.fillColor("#111111")
  }

  renderHeader()
  y += 22

  doc.fontSize(9).fillColor("#111111")

  for (const l of args.lines) {
    const desc = String(l.designation ?? "")
    const descHeight = doc.heightOfString(desc, { width: widths.designation })
    const rowHeight = Math.max(14, descHeight)

    if (y + rowHeight > maxY) {
      renderFooter()
      doc.addPage()
      pageNo++
      y = doc.page.margins.top
      renderHeader()
      y += 22
    }

    doc.text(String(l.ordre ?? ""), marginX, y, { width: widths.ordre })
    doc.text(desc, marginX + widths.ordre, y, { width: widths.designation })
    doc.text(String(l.code_piece ?? ""), marginX + widths.ordre + widths.designation, y, { width: widths.code_piece })
    doc.text(String(l.quantite ?? 0), marginX + widths.ordre + widths.designation + widths.code_piece, y, {
      width: widths.quantite,
      align: "right",
    })
    doc.text(String(l.unite ?? ""), marginX + widths.ordre + widths.designation + widths.code_piece + widths.quantite, y, {
      width: widths.unite,
      align: "right",
    })
    doc.text(String(l.delai_client ?? ""), marginX + widths.ordre + widths.designation + widths.code_piece + widths.quantite + widths.unite, y, {
      width: widths.delai,
      align: "right",
    })

    y += rowHeight + 6
    doc.moveTo(marginX, y).lineTo(marginX + pageWidth, y).strokeColor("#f1f5f9").stroke()
    y += 6
  }

  renderFooter()
  return { y, pageNo }
}

export async function svcRenderPackBonLivraisonPdf(args: { preview: LivraisonPackPreview; version: number }): Promise<Buffer> {
  const company = await getCompanyHeader()
  const p = args.preview
  const bl = p.bon_livraison
  const lines = p.lignes
  const creationDate = toUtcMidnightFromIso(bl.date_expedition ?? bl.date_creation)
  
  return renderPdfToBuffer({ creationDate, render: (doc) => {
    doc.font("Helvetica-Bold").fontSize(20).fillColor("#111111").text("BON DE LIVRAISON", { align: "right" })
    doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text(`Version V${args.version}`, { align: "right" })
    doc.fillColor("#111111")
    doc.moveDown(0.5)

    doc.fontSize(11)
    drawKeyValue(doc, "Numero:", bl.numero)
    drawKeyValue(doc, "Date:", formatDateFR(bl.date_creation))
    drawKeyValue(doc, "Date expedition:", formatDateFR(bl.date_expedition))
    if (bl.transporteur) drawKeyValue(doc, "Transporteur:", bl.transporteur)
    if (bl.tracking_number) drawKeyValue(doc, "Suivi:", bl.tracking_number)

    doc.moveDown(1)

    if (company) {
      doc.font("Helvetica-Bold").fontSize(11).text(company)
      doc.moveDown(0.5)
    }

    doc.font("Helvetica-Bold").fontSize(11).text("Client")
    doc.font("Helvetica").fontSize(11).text(bl.client.company_name)
    doc.fillColor("#6b7280").fontSize(9).text(`ID: ${bl.client.client_id}`)
    doc.fillColor("#111111")

    doc.moveDown(0.75)
    doc.font("Helvetica-Bold").fontSize(11).text("Adresse de livraison")
    doc.font("Helvetica").fontSize(11).text(bl.adresse_livraison?.label ?? "-")

    doc.moveDown(1)

    const table = renderBlLinesTable(doc, {
      startY: doc.y,
      pageNoStart: 1,
      lines: lines.map((l) => ({
        ordre: l.ordre,
        designation: l.designation,
        code_piece: l.code_piece,
        quantite: l.quantite,
        unite: l.unite,
        delai_client: l.delai_client,
      })),
    })

    const boxY = Math.min(table.y + 10, doc.page.height - doc.page.margins.bottom - 70)
    doc.moveTo(doc.page.margins.left, boxY).lineTo(doc.page.width - doc.page.margins.right, boxY).strokeColor("#e5e7eb").stroke()
    doc.moveDown(1)
    doc.font("Helvetica-Bold").fontSize(11).text("Reception")
    doc.font("Helvetica").fontSize(10)
    doc.text("Nom / Signature:")
    doc.moveDown(0.5)
    doc.text("Date:")
  }})
}

export async function svcRenderPackCofcPdf(args: {
  preview: LivraisonPackPreview
  version: number
  signataireLabel: string
  commentairePack: string | null
  includeDocuments: boolean
}): Promise<Buffer> {
  const company = await getCompanyHeader()
  const p = args.preview
  const bl = p.bon_livraison
  const creationDate = toUtcMidnightFromIso(bl.date_expedition ?? bl.date_creation)
  
  const lines = p.lignes.map((l) => {
    const lotCodes = Array.from(
      new Set(
        (l.allocations ?? [])
          .map((a) => a.lot?.lot_code ?? null)
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      )
    )
    return {
      designation: l.designation,
      code_piece: l.code_piece,
      quantite: l.quantite,
      unite: l.unite,
      lots: lotCodes,
    }
  })

  const movements = p.stock_movements
  
  return renderPdfToBuffer({ creationDate, render: (doc) => {
    doc.font("Helvetica-Bold").fontSize(20).fillColor("#111111").text("CERTIFICAT DE CONFORMITE", { align: "right" })
    doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text(`BL ${bl.numero} • Version V${args.version}`, { align: "right" })
    doc.fillColor("#111111")
    doc.moveDown(0.75)

    if (company) {
      doc.font("Helvetica-Bold").fontSize(11).text(company)
      doc.moveDown(0.5)
    }

    doc.font("Helvetica").fontSize(11)
    drawKeyValue(doc, "Client:", bl.client.company_name)
    drawKeyValue(doc, "Date:", formatDateFR(bl.date_expedition ?? bl.date_creation))
    if (bl.commande?.numero) drawKeyValue(doc, "Commande:", bl.commande.numero)
    if (bl.affaire?.reference) drawKeyValue(doc, "Affaire:", bl.affaire.reference)

    doc.moveDown(1)
    doc.font("Helvetica").fontSize(11)
    doc.text(
      "Nous certifions que les pieces livrees sont conformes aux exigences contractuelles et aux controles realises.",
      { align: "left" }
    )
    doc.moveDown(0.5)

    if (args.commentairePack && args.commentairePack.trim()) {
      doc.font("Helvetica-Bold").fontSize(10).text("Commentaire")
      doc.font("Helvetica").fontSize(10).text(args.commentairePack.trim())
      doc.moveDown(0.75)
    }

    const marginX = doc.page.margins.left
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right
    const maxY = doc.page.height - doc.page.margins.bottom - 120
    const widths = {
      designation: Math.max(240, pageWidth - (80 + 70 + 160)),
      code: 80,
      qte: 70,
      lots: 160,
    }

    const renderHeader = (y: number) => {
      doc.fontSize(9).fillColor("#111111").font("Helvetica-Bold")
      doc.text("Designation", marginX, y, { width: widths.designation })
      doc.text("Code", marginX + widths.designation, y, { width: widths.code })
      doc.text("Qte", marginX + widths.designation + widths.code, y, { width: widths.qte, align: "right" })
      doc.text("Lots expedies", marginX + widths.designation + widths.code + widths.qte, y, { width: widths.lots })
      doc.moveTo(marginX, y + 14).lineTo(marginX + pageWidth, y + 14).strokeColor("#e5e7eb").stroke()
      doc.font("Helvetica").fillColor("#111111")
    }

    let y = doc.y
    renderHeader(y)
    y += 22

    doc.fontSize(9).fillColor("#111111")
    for (const l of lines) {
      const desc = String(l.designation ?? "")
      const lots = l.lots.length ? l.lots.join(", ") : "-"
      const rowHeight = Math.max(14, doc.heightOfString(desc, { width: widths.designation }), doc.heightOfString(lots, { width: widths.lots }))

      if (y + rowHeight > maxY) {
        doc.addPage()
        y = doc.page.margins.top
        renderHeader(y)
        y += 22
      }

      doc.text(desc, marginX, y, { width: widths.designation })
      doc.text(String(l.code_piece ?? ""), marginX + widths.designation, y, { width: widths.code })
      doc.text(String(l.quantite ?? 0), marginX + widths.designation + widths.code, y, { width: widths.qte, align: "right" })
      doc.text(lots, marginX + widths.designation + widths.code + widths.qte, y, { width: widths.lots })
      y += rowHeight + 6
      doc.moveTo(marginX, y).lineTo(marginX + pageWidth, y).strokeColor("#f1f5f9").stroke()
      y += 6
    }

    doc.moveDown(1)
    if (movements.length) {
      doc.font("Helvetica-Bold").fontSize(10).text("Resume tracabilite")
      doc.font("Helvetica").fontSize(10)
      for (const m of movements) {
        const label = `${m.movement_no ?? m.id} • ${m.status} • ${formatDateFR(m.posted_at)}`
        doc.text(label)
      }
      doc.moveDown(0.5)
    }

    if (args.includeDocuments) {
      doc.font("Helvetica-Bold").fontSize(10).text("Documents associes")
      doc.font("Helvetica").fontSize(10)
      const docs = p.documents_attached
      if (docs.length) {
        for (const d of docs) {
          doc.text(`- ${d.document_name ?? d.document_id}`)
        }
      } else {
        doc.text("- Aucun")
      }
      doc.moveDown(0.5)
    }

    doc.font("Helvetica-Bold").fontSize(11).text("Etabli par")
    doc.font("Helvetica").fontSize(11).text(args.signataireLabel)
    doc.fontSize(10).fillColor("#6b7280").text(`Date: ${formatDateFR(bl.date_expedition ?? bl.date_creation)}`)
    doc.fillColor("#111111")
  }})
}
