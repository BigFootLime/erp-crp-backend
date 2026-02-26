import PDFDocument from "pdfkit"

import type { AsBuiltPreview } from "../types/asbuilt.types"

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

export async function svcRenderAsbuiltPdf(args: {
  preview: AsBuiltPreview
  version: number
  generatedAt: Date
  signataireLabel: string
  commentaire: string | null
}): Promise<Buffer> {
  const p = args.preview

  return renderPdfToBuffer({
    creationDate: args.generatedAt,
    render: (doc) => {
      doc.fontSize(18).font("Helvetica-Bold").text("Dossier de lot (as-built)")
      doc.moveDown(0.6)

      doc.fontSize(11).font("Helvetica")
      drawKeyValue(doc, "Lot :", p.lot.lot_code)
      drawKeyValue(doc, "Article :", `${p.lot.article_code} - ${p.lot.article_designation}`)
      drawKeyValue(doc, "Version :", String(args.version))
      drawKeyValue(doc, "Genere le :", formatDateFR(args.generatedAt.toISOString()))
      drawKeyValue(doc, "Signataire :", args.signataireLabel)
      if (args.commentaire && args.commentaire.trim()) drawKeyValue(doc, "Commentaire :", args.commentaire.trim())

      doc.moveDown(0.8)
      doc.font("Helvetica-Bold").text("Synthese")
      doc.font("Helvetica")
      doc.text(`OF lie(s): ${p.ofs.length}`)
      doc.text(`BL lie(s): ${p.bon_livraisons.length}`)
      doc.text(`Non-conformites: ${p.non_conformities.length} (ouvertes: ${p.checks.open_non_conformities}, en retard: ${p.checks.overdue_non_conformities})`)

      if (p.ofs.length) {
        doc.moveDown(0.8)
        doc.font("Helvetica-Bold").text("Ordres de fabrication")
        doc.font("Helvetica")
        for (const of of p.ofs.slice(0, 30)) {
          doc.text(`- OF ${of.numero} (${of.statut}) - Piece: ${of.piece_code}`)
        }
      }

      if (p.bon_livraisons.length) {
        doc.moveDown(0.8)
        doc.font("Helvetica-Bold").text("Bons de livraison")
        doc.font("Helvetica")
        for (const bl of p.bon_livraisons.slice(0, 30)) {
          const sig = bl.reception_date_signature ? `, reception signee: ${formatDateFR(bl.reception_date_signature)}` : ""
          doc.text(`- BL ${bl.numero} (${bl.statut})${sig}`)
        }
      }

      if (p.non_conformities.length) {
        doc.moveDown(0.8)
        doc.font("Helvetica-Bold").text("Non-conformites")
        doc.font("Helvetica")
        for (const nc of p.non_conformities.slice(0, 50)) {
          const due = nc.due_date ? `, echeance: ${formatDateFR(nc.due_date)}` : ""
          doc.text(`- NC ${nc.reference} (${nc.status}, ${nc.severity})${due}`)
        }
      }

      doc.moveDown(1)
      doc.fontSize(9).fillColor("#6b7280").text("Document genere automatiquement par l'ERP.")
      doc.fillColor("#111111")
    },
  })
}
