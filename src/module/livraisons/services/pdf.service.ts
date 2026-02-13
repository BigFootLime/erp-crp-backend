import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"

import PDFDocument from "pdfkit"

import pool from "../../../config/database"
import { HttpError } from "../../../utils/httpError"
import { repoGetLivraisonDetail, repoGetDocumentName } from "../repository/livraisons.repository"

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

async function ensureDocsDir(): Promise<string> {
  const uploadDir = path.resolve("uploads/docs/livraisons")
  await fs.mkdir(uploadDir, { recursive: true })
  return uploadDir
}

async function writePdfToFile(filePath: string, render: (doc: PDFKit.PDFDocument) => void): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const doc = new PDFDocument({ size: "A4", margin: 40 })
  const chunks: Buffer[] = []
  doc.on("data", (c) => chunks.push(c as Buffer))
  render(doc)
  doc.end()
  await new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve())
    doc.on("error", (err) => reject(err))
  })
  await fs.writeFile(filePath, Buffer.concat(chunks))
}

function renderTableHeader(doc: PDFKit.PDFDocument, x: number, y: number, widths: number[]) {
  const [wDesc, wQty, wUnit] = widths
  doc.fontSize(9).fillColor("#111111").font("Helvetica-Bold")
  doc.text("Designation", x, y, { width: wDesc })
  doc.text("Qte", x + wDesc, y, { width: wQty, align: "right" })
  doc.text("Unite", x + wDesc + wQty, y, { width: wUnit, align: "right" })
  doc.moveTo(x, y + 14).lineTo(x + widths.reduce((a, b) => a + b, 0), y + 14).strokeColor("#e5e7eb").stroke()
  doc.font("Helvetica").fillColor("#111111")
}

function renderLines(
  doc: PDFKit.PDFDocument,
  lines: Array<{ designation: string; quantite: number; unite: string | null }>,
  startY: number
) {
  const marginX = doc.page.margins.left
  const maxY = doc.page.height - doc.page.margins.bottom - 120
  const widths = [340, 60, 60]
  let y = startY

  renderTableHeader(doc, marginX, y, widths)
  y += 22

  doc.fontSize(9).fillColor("#111111")

  for (const l of lines) {
    const desc = String(l.designation ?? "")
    const rowHeight = Math.max(14, doc.heightOfString(desc, { width: widths[0] }))
    if (y + rowHeight > maxY) {
      doc.addPage()
      y = doc.page.margins.top
      renderTableHeader(doc, marginX, y, widths)
      y += 22
    }

    doc.text(desc, marginX, y, { width: widths[0] })
    doc.text(String(l.quantite ?? 0), marginX + widths[0], y, { width: widths[1], align: "right" })
    doc.text(String(l.unite ?? ""), marginX + widths[0] + widths[1], y, { width: widths[2], align: "right" })

    y += rowHeight + 6
    doc.moveTo(marginX, y).lineTo(marginX + widths.reduce((a, b) => a + b, 0), y).strokeColor("#f1f5f9").stroke()
    y += 6
  }

  return y
}

async function getCompanyHeader(): Promise<string | null> {
  const res = await pool.query<{ biller_name: string }>(
    `SELECT biller_name FROM factureur ORDER BY biller_id ASC LIMIT 1`
  )
  const name = res.rows[0]?.biller_name
  return typeof name === "string" && name.trim() ? name.trim() : null
}

export async function svcGetLatestLivraisonPdfDocument(id: number): Promise<{ document_id: string; version: number } | null> {
  const res = await pool.query<{ document_id: string; version: number }>(
    `
    SELECT d.document_id::text AS document_id, d.version
    FROM bon_livraison_documents d
    WHERE d.bon_livraison_id = $1 AND d.type = 'PDF'
    ORDER BY d.version DESC, d.id DESC
    LIMIT 1
    `,
    [id]
  )
  const row = res.rows[0]
  return row ? { document_id: row.document_id, version: row.version } : null
}

export async function svcGetPdfFilePath(documentId: string): Promise<string> {
  const docsDir = await ensureDocsDir()
  return path.join(docsDir, `${documentId}.pdf`)
}

export async function svcGenerateLivraisonPdf(bonLivraisonId: number, userId: number): Promise<{ document_id: string; version: number }> {
  const detail = await repoGetLivraisonDetail(bonLivraisonId)
  if (!detail) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")

  const existing = await svcGetLatestLivraisonPdfDocument(bonLivraisonId)
  const version = (existing?.version ?? 0) + 1

  const docsDir = await ensureDocsDir()
  const documentId = crypto.randomUUID()
  const fileName = `Bon_livraison_${detail.bon_livraison.numero}.pdf`
  const filePath = path.join(docsDir, `${documentId}.pdf`)

  const company = await getCompanyHeader()
  await writePdfToFile(filePath, (doc) => {
    const bl = detail.bon_livraison

    doc.font("Helvetica-Bold").fontSize(20).fillColor("#111111").text("BON DE LIVRAISON", { align: "right" })
    doc.moveDown(0.5)
    doc.font("Helvetica").fontSize(11)
    doc.text(`Numero: ${bl.numero}`, { align: "right" })
    doc.text(`Date: ${formatDateFR(bl.date_creation)}`, { align: "right" })
    if (bl.commande?.numero) doc.text(`Commande: ${bl.commande.numero}`, { align: "right" })

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
    const afterLinesY = renderLines(
      doc,
      detail.lignes.map((l) => ({ designation: l.designation, quantite: l.quantite, unite: l.unite })),
      doc.y
    )

    const boxY = Math.min(afterLinesY + 10, doc.page.height - doc.page.margins.bottom - 90)
    doc.moveTo(doc.page.margins.left, boxY).lineTo(doc.page.width - doc.page.margins.right, boxY).strokeColor("#e5e7eb").stroke()
    doc.moveDown(1)
    doc.font("Helvetica-Bold").fontSize(11).text("Reception")
    doc.font("Helvetica").fontSize(10)
    doc.text("Nom / Signature:")
    doc.moveDown(0.5)
    doc.text("Date:")
  })

  const db = await pool.connect()
  try {
    await db.query("BEGIN")
    await db.query(`INSERT INTO documents_clients (id, document_name, type) VALUES ($1, $2, $3)`, [documentId, fileName, "PDF"])
    await db.query(
      `INSERT INTO bon_livraison_documents (bon_livraison_id, document_id, type, version, uploaded_by) VALUES ($1, $2, $3, $4, $5)`,
      [bonLivraisonId, documentId, "PDF", version, userId]
    )
    await db.query(
      `INSERT INTO bon_livraison_event_log (bon_livraison_id, event_type, old_values, new_values, user_id)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`,
      [bonLivraisonId, "PDF_GENERATED", null, JSON.stringify({ document_id: documentId, version }), userId]
    )
    await db.query(`UPDATE bon_livraison SET updated_at = now(), updated_by = $2 WHERE id = $1`, [bonLivraisonId, userId])
    await db.query("COMMIT")
  } catch (err) {
    await db.query("ROLLBACK")
    await fs.unlink(filePath).catch(() => undefined)
    throw err
  } finally {
    db.release()
  }

  return { document_id: documentId, version }
}

export async function svcGetDocumentName(documentId: string) {
  return repoGetDocumentName(documentId)
}
