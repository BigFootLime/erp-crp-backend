import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import PDFDocument from "pdfkit";

import { ensureDocumentStoragePath } from "../../../utils/cerpStorage";
import type {
  AvoirDocumentArtifact,
  AvoirDocumentSnapshot,
} from "../repository/avoir-workflow.repository";

function partyName(snapshot: Record<string, unknown>): string {
  for (const key of ["company_name", "name", "raison_sociale"]) {
    const value = snapshot[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Non renseigné";
}

async function render(snapshot: AvoirDocumentSnapshot): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 44, compress: true });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

  doc.info.Title = `Avoir ${snapshot.legal_number}`;
  doc.font("Helvetica-Bold").fontSize(22).fillColor("#172033").text("AVOIR", { align: "right" });
  doc.font("Helvetica").fontSize(10);
  doc.text(`N° ${snapshot.legal_number}`, { align: "right" });
  doc.text(`Date : ${snapshot.issue_date}`, { align: "right" });
  doc.text(`Facture corrigée : ${snapshot.facture_number}`, { align: "right" });
  doc.moveDown(1.5);
  doc.font("Helvetica-Bold").text("Émetteur");
  doc.font("Helvetica").text(partyName(snapshot.issuer_snapshot));
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").text("Client");
  doc.font("Helvetica").text(partyName(snapshot.client_snapshot));
  doc.moveDown(1);
  doc.font("Helvetica-Bold").text(`Motif (${snapshot.reason_code})`);
  doc.font("Helvetica").text(snapshot.reason);
  doc.moveDown(1.2);

  for (const line of snapshot.lines) {
    if (doc.y > 700) doc.addPage();
    doc.font("Helvetica-Bold").fontSize(9).text(line.designation, { continued: false });
    doc
      .font("Helvetica")
      .text(
        `${line.quantity_selected} × ${line.unit_price_ex_tax} ${snapshot.currency} HT — TVA ${line.tax_rate_percent} % — ${line.total_incl_tax} ${snapshot.currency} TTC`
      );
    doc.moveDown(0.5);
  }

  doc.moveDown(1);
  doc.font("Helvetica").fontSize(10).text(`Total HT : ${snapshot.totals.total_ex_tax} ${snapshot.currency}`, {
    align: "right",
  });
  doc.text(`TVA : ${snapshot.totals.total_tax} ${snapshot.currency}`, { align: "right" });
  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .text(`Total TTC : ${snapshot.totals.total_incl_tax} ${snapshot.currency}`, { align: "right" });
  doc
    .font("Helvetica")
    .fontSize(7)
    .fillColor("#667085")
    .text(
      `Document légal version 1 — instantané immuable ${snapshot.uuid}.`,
      44,
      doc.page.height - 48,
      { width: 507, align: "center" }
    );

  doc.end();
  await new Promise<void>((resolve, reject) => {
    doc.once("end", resolve);
    doc.once("error", reject);
  });
  return Buffer.concat(chunks);
}

export async function writeImmutableAvoirDocument(
  snapshot: AvoirDocumentSnapshot
): Promise<AvoirDocumentArtifact> {
  const documentId = crypto.randomUUID();
  const safeNumber = snapshot.legal_number.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const fileName = `Avoir_${safeNumber}_v1.pdf`;
  const filePath = path.join(ensureDocumentStoragePath(), `${documentId}.pdf`);
  const pdf = await render(snapshot);
  await fs.writeFile(filePath, pdf, { flag: "wx" });
  return {
    documentId,
    fileName,
    checksumSha256: crypto.createHash("sha256").update(pdf).digest("hex"),
    fileSizeBytes: pdf.byteLength,
    cleanup: async () => {
      await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}
