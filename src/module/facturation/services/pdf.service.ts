import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoGetAvoir } from "../repository/avoirs.repository";
import { repoGetFacture } from "../repository/factures.repository";

function formatCurrencyEUR(amount: number): string {
  const n = Number.isFinite(amount) ? amount : 0;
  return `${n.toFixed(2)} EUR`;
}

function formatDateFR(iso: string | null | undefined): string {
  if (!iso) return "-";
  const raw = String(iso);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;

  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

async function ensureDocsDir(): Promise<string> {
  const uploadDir = path.resolve("uploads/docs");
  await fs.mkdir(uploadDir, { recursive: true });
  return uploadDir;
}

function renderTableHeader(doc: PDFKit.PDFDocument, x: number, y: number, widths: number[]) {
  const [wDesc, wQty, wPu, wTva, wTotal] = widths;
  doc.fontSize(9).fillColor("#111111").font("Helvetica-Bold");
  doc.text("Designation", x, y, { width: wDesc });
  doc.text("Qte", x + wDesc, y, { width: wQty, align: "right" });
  doc.text("PU HT", x + wDesc + wQty, y, { width: wPu, align: "right" });
  doc.text("TVA", x + wDesc + wQty + wPu, y, { width: wTva, align: "right" });
  doc.text("Total TTC", x + wDesc + wQty + wPu + wTva, y, { width: wTotal, align: "right" });
  doc.moveTo(x, y + 14).lineTo(x + widths.reduce((a, b) => a + b, 0), y + 14).strokeColor("#e5e7eb").stroke();
  doc.font("Helvetica").fillColor("#111111");
}

function renderLines(
  doc: PDFKit.PDFDocument,
  lines: Array<{ designation: string; quantite: number; prix_unitaire_ht: number; taux_tva: number; total_ttc: number }>,
  startY: number
) {
  const marginX = doc.page.margins.left;
  const maxY = doc.page.height - doc.page.margins.bottom - 80;
  const widths = [280, 45, 70, 45, 80];
  let y = startY;

  renderTableHeader(doc, marginX, y, widths);
  y += 22;

  doc.fontSize(9).fillColor("#111111");

  for (const l of lines) {
    const desc = l.designation ?? "";
    const rowHeight = Math.max(14, doc.heightOfString(desc, { width: widths[0] }));
    if (y + rowHeight > maxY) {
      doc.addPage();
      y = doc.page.margins.top;
      renderTableHeader(doc, marginX, y, widths);
      y += 22;
    }

    doc.text(desc, marginX, y, { width: widths[0] });
    doc.text(String(l.quantite ?? 0), marginX + widths[0], y, { width: widths[1], align: "right" });
    doc.text(formatCurrencyEUR(l.prix_unitaire_ht ?? 0), marginX + widths[0] + widths[1], y, {
      width: widths[2],
      align: "right",
    });
    doc.text(`${Number(l.taux_tva ?? 0).toFixed(0)}%`, marginX + widths[0] + widths[1] + widths[2], y, {
      width: widths[3],
      align: "right",
    });
    doc.text(formatCurrencyEUR(l.total_ttc ?? 0), marginX + widths[0] + widths[1] + widths[2] + widths[3], y, {
      width: widths[4],
      align: "right",
    });

    y += rowHeight + 6;
    doc.moveTo(marginX, y).lineTo(marginX + widths.reduce((a, b) => a + b, 0), y).strokeColor("#f1f5f9").stroke();
    y += 6;
  }

  return y;
}

async function writePdfToFile(
  filePath: string,
  render: (doc: PDFKit.PDFDocument) => void
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const chunks: Buffer[] = [];
  doc.on("data", (c) => chunks.push(c as Buffer));

  render(doc);
  doc.end();

  await new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve());
    doc.on("error", (err) => reject(err));
  });

  const buf = Buffer.concat(chunks);
  await fs.writeFile(filePath, buf);
}

export async function svcGenerateFacturePdf(factureId: number): Promise<{ document_id: string }> {
  const detail = await repoGetFacture(factureId, "client,lignes");
  if (!detail) throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture not found");

  const docsDir = await ensureDocsDir();
  const documentId = crypto.randomUUID();
  const fileName = `Facture_${detail.facture.numero}.pdf`;
  const filePath = path.join(docsDir, `${documentId}.pdf`);

  await writePdfToFile(filePath, (doc) => {
    const f = detail.facture;
    const clientName = f.client?.company_name ?? f.client_id;

    doc.font("Helvetica-Bold").fontSize(20).fillColor("#111111").text("FACTURE", { align: "right" });
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(11).text(`Numero: ${f.numero}`, { align: "right" });
    doc.text(`Date: ${formatDateFR(f.date_emission)}`, { align: "right" });
    doc.text(`Echeance: ${formatDateFR(f.date_echeance)}`, { align: "right" });

    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(11).text("Client");
    doc.font("Helvetica").fontSize(11).text(clientName);
    doc.fillColor("#6b7280").fontSize(9).text(`ID: ${f.client_id}`);
    doc.fillColor("#111111");

    doc.moveDown(1);
    const lines = detail.lignes.map((l) => ({
      designation: l.designation,
      quantite: l.quantite,
      prix_unitaire_ht: l.prix_unitaire_ht,
      taux_tva: l.taux_tva ?? 0,
      total_ttc: l.total_ttc,
    }));
    const afterLinesY = renderLines(doc, lines, doc.y);

    const boxY = Math.min(afterLinesY + 10, doc.page.height - doc.page.margins.bottom - 70);
    doc.font("Helvetica-Bold").fontSize(11).text("Totaux", doc.page.margins.left, boxY);
    doc.font("Helvetica").fontSize(11);
    doc.text(`Total HT: ${formatCurrencyEUR(f.total_ht)}`, { align: "right" });
    doc.text(`Total TTC: ${formatCurrencyEUR(f.total_ttc)}`, { align: "right" });

    if (f.commentaires) {
      doc.moveDown(1);
      doc.font("Helvetica-Bold").fontSize(10).text("Notes");
      doc.font("Helvetica").fontSize(10).text(String(f.commentaires));
    }
  });

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      `INSERT INTO documents_clients (id, document_name, type) VALUES ($1, $2, $3)` ,
      [documentId, fileName, "PDF"]
    );
    await db.query(
      `INSERT INTO facture_documents (facture_id, document_id, type) VALUES ($1, $2, $3)` ,
      [factureId, documentId, "PDF"]
    );
    await db.query(`UPDATE facture SET updated_at = now() WHERE id = $1`, [factureId]);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    await fs.unlink(filePath).catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }

  return { document_id: documentId };
}

export async function svcGenerateAvoirPdf(avoirId: number): Promise<{ document_id: string }> {
  const detail = await repoGetAvoir(avoirId, "client,lignes,facture");
  if (!detail) throw new HttpError(404, "AVOIR_NOT_FOUND", "Avoir not found");

  const docsDir = await ensureDocsDir();
  const documentId = crypto.randomUUID();
  const fileName = `Avoir_${detail.avoir.numero}.pdf`;
  const filePath = path.join(docsDir, `${documentId}.pdf`);

  await writePdfToFile(filePath, (doc) => {
    const a = detail.avoir;
    const clientName = a.client?.company_name ?? a.client_id;

    doc.font("Helvetica-Bold").fontSize(20).fillColor("#111111").text("AVOIR", { align: "right" });
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(11).text(`Numero: ${a.numero}`, { align: "right" });
    doc.text(`Date: ${formatDateFR(a.date_emission)}`, { align: "right" });
    if (a.facture?.numero) {
      doc.text(`Facture: ${a.facture.numero}`, { align: "right" });
    }

    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(11).text("Client");
    doc.font("Helvetica").fontSize(11).text(clientName);
    doc.fillColor("#6b7280").fontSize(9).text(`ID: ${a.client_id}`);
    doc.fillColor("#111111");

    if (a.motif) {
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(10).text("Motif");
      doc.font("Helvetica").fontSize(10).text(String(a.motif));
    }

    doc.moveDown(1);
    const lines = detail.lignes.map((l) => ({
      designation: l.designation,
      quantite: l.quantite,
      prix_unitaire_ht: l.prix_unitaire_ht,
      taux_tva: l.taux_tva ?? 0,
      total_ttc: l.total_ttc,
    }));
    const afterLinesY = renderLines(doc, lines, doc.y);

    const boxY = Math.min(afterLinesY + 10, doc.page.height - doc.page.margins.bottom - 70);
    doc.font("Helvetica-Bold").fontSize(11).text("Totaux", doc.page.margins.left, boxY);
    doc.font("Helvetica").fontSize(11);
    doc.text(`Total HT: ${formatCurrencyEUR(a.total_ht)}`, { align: "right" });
    doc.text(`Total TTC: ${formatCurrencyEUR(a.total_ttc)}`, { align: "right" });
  });

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      `INSERT INTO documents_clients (id, document_name, type) VALUES ($1, $2, $3)` ,
      [documentId, fileName, "PDF"]
    );
    await db.query(
      `INSERT INTO avoir_documents (avoir_id, document_id, type) VALUES ($1, $2, $3)` ,
      [avoirId, documentId, "PDF"]
    );
    await db.query(`UPDATE avoir SET updated_at = now() WHERE id = $1`, [avoirId]);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    await fs.unlink(filePath).catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }

  return { document_id: documentId };
}

export async function svcGetLatestFacturePdfDocumentId(factureId: number): Promise<string | null> {
  const res = await pool.query<{ document_id: string }>(
    `
    SELECT fd.document_id::text AS document_id
    FROM facture_documents fd
    WHERE fd.facture_id = $1
    ORDER BY fd.id DESC
    LIMIT 1
    `,
    [factureId]
  );
  return res.rows[0]?.document_id ?? null;
}

export async function svcGetLatestAvoirPdfDocumentId(avoirId: number): Promise<string | null> {
  const res = await pool.query<{ document_id: string }>(
    `
    SELECT ad.document_id::text AS document_id
    FROM avoir_documents ad
    WHERE ad.avoir_id = $1
    ORDER BY ad.id DESC
    LIMIT 1
    `,
    [avoirId]
  );
  return res.rows[0]?.document_id ?? null;
}

export async function svcGetPdfFilePath(documentId: string): Promise<string> {
  const docsDir = await ensureDocsDir();
  return path.join(docsDir, `${documentId}.pdf`);
}

export async function svcGetDocumentName(documentId: string): Promise<string | null> {
  const res = await pool.query<{ document_name: string }>(
    `SELECT document_name FROM documents_clients WHERE id = $1`,
    [documentId]
  );
  const name = res.rows[0]?.document_name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}
