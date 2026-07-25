import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import PDFDocument from "pdfkit";

import { ensureDocumentStoragePath } from "../../../utils/cerpStorage";
import type {
  FinanceDocumentArtifact,
  FinanceDocumentSnapshot,
} from "../repository/facture-workflow.repository";

function textValue(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function renderParty(
  doc: PDFKit.PDFDocument,
  title: string,
  party: Record<string, unknown>
): void {
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#172033").text(title);
  doc.font("Helvetica").fontSize(9).fillColor("#172033");

  const nestedAddress =
    party.billing_address && typeof party.billing_address === "object"
      ? (party.billing_address as Record<string, unknown>)
      : {};
  const addressLine = [
    textValue(nestedAddress, "house_number"),
    textValue(nestedAddress, "street"),
  ]
    .filter(Boolean)
    .join(" ");
  const lines = [
    textValue(party, "company_name", "name", "raison_sociale"),
    textValue(party, "address_line_1", "address", "adresse") || addressLine,
    textValue(party, "address_line_2", "adresse_complement") ||
      textValue(nestedAddress, "address_complement"),
    [
      textValue(party, "postal_code", "code_postal") ||
        textValue(nestedAddress, "postal_code"),
      textValue(party, "city", "ville") || textValue(nestedAddress, "city"),
    ]
      .filter(Boolean)
      .join(" "),
    textValue(party, "country", "pays") || textValue(nestedAddress, "country"),
  ].filter((value): value is string => Boolean(value));

  for (const line of lines) doc.text(line);

  const siret = textValue(party, "siret");
  const vat = textValue(party, "vat_number", "numero_tva", "tva_intracommunautaire");
  if (siret) doc.text(`SIRET : ${siret}`);
  if (vat) doc.text(`TVA : ${vat}`);
}

function formatDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function renderSnapshot(doc: PDFKit.PDFDocument, snapshot: FinanceDocumentSnapshot): void {
  doc.info.Title = `Facture ${snapshot.legal_number}`;
  doc.info.Subject = "Facture émise depuis un instantané immuable";
  doc.info.CreationDate = new Date(`${snapshot.issue_date}T12:00:00.000Z`);

  doc
    .font("Helvetica-Bold")
    .fontSize(21)
    .fillColor("#172033")
    .text("FACTURE", { align: "right" });
  doc.font("Helvetica").fontSize(10);
  doc.text(`N° ${snapshot.legal_number}`, { align: "right" });
  doc.text(`Émise le ${formatDate(snapshot.issue_date)}`, { align: "right" });
  doc.text(`Référence brouillon ${snapshot.draft_reference}`, { align: "right" });

  const partyY = Math.max(doc.y + 22, 105);
  doc.save();
  doc.rect(40, partyY, 250, 112).fillAndStroke("#f7f9fc", "#d8dee9");
  doc.restore();
  doc.x = 52;
  doc.y = partyY + 12;
  renderParty(doc, "Émetteur", snapshot.issuer_snapshot);

  doc.save();
  doc.rect(305, partyY, 250, 112).fillAndStroke("#ffffff", "#d8dee9");
  doc.restore();
  doc.x = 317;
  doc.y = partyY + 12;
  renderParty(doc, "Client facturé", snapshot.client_snapshot);

  let y = partyY + 140;
  const columns = {
    designation: 218,
    quantity: 55,
    unitPrice: 72,
    tax: 52,
    total: 78,
  };
  const tableWidth = Object.values(columns).reduce((sum, value) => sum + value, 0);

  const drawHeader = () => {
    doc.save();
    doc.rect(40, y, tableWidth, 22).fill("#172033");
    doc.restore();
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#ffffff");
    doc.text("Désignation", 46, y + 7, { width: columns.designation - 12 });
    doc.text("Qté", 40 + columns.designation, y + 7, {
      width: columns.quantity - 6,
      align: "right",
    });
    doc.text("PU HT", 40 + columns.designation + columns.quantity, y + 7, {
      width: columns.unitPrice - 6,
      align: "right",
    });
    doc.text("TVA", 40 + columns.designation + columns.quantity + columns.unitPrice, y + 7, {
      width: columns.tax - 6,
      align: "right",
    });
    doc.text(
      "Total TTC",
      40 + columns.designation + columns.quantity + columns.unitPrice + columns.tax,
      y + 7,
      { width: columns.total - 6, align: "right" }
    );
    y += 22;
  };

  drawHeader();
  for (const line of snapshot.lines) {
    const rowHeight = Math.max(
      25,
      doc.heightOfString(line.designation, { width: columns.designation - 12 }) + 12
    );
    if (y + rowHeight > doc.page.height - 150) {
      doc.addPage();
      y = 45;
      drawHeader();
    }
    doc.save();
    doc.rect(40, y, tableWidth, rowHeight).fillAndStroke("#ffffff", "#e5e9f0");
    doc.restore();
    doc.font("Helvetica").fontSize(8).fillColor("#172033");
    doc.text(line.designation, 46, y + 7, { width: columns.designation - 12 });
    doc.text(line.quantity, 40 + columns.designation, y + 7, {
      width: columns.quantity - 6,
      align: "right",
    });
    doc.text(`${line.unit_price_ex_tax} ${snapshot.currency}`, 40 + columns.designation + columns.quantity, y + 7, {
      width: columns.unitPrice - 6,
      align: "right",
    });
    doc.text(`${line.tax_rate_percent} %`, 40 + columns.designation + columns.quantity + columns.unitPrice, y + 7, {
      width: columns.tax - 6,
      align: "right",
    });
    doc.text(
      `${line.total_incl_tax} ${snapshot.currency}`,
      40 + columns.designation + columns.quantity + columns.unitPrice + columns.tax,
      y + 7,
      { width: columns.total - 6, align: "right" }
    );
    y += rowHeight;
  }

  y += 16;
  if (y > doc.page.height - 185) {
    doc.addPage();
    y = 55;
  }
  doc.font("Helvetica").fontSize(9).fillColor("#172033");
  doc.text(`Sous-total HT : ${snapshot.totals.subtotal_ex_tax} ${snapshot.currency}`, 315, y, {
    width: 240,
    align: "right",
  });
  y += 15;
  if (snapshot.totals.global_discount_amount !== "0.00") {
    doc.text(
      `Remise globale (${snapshot.totals.global_discount_percent} %) : -${snapshot.totals.global_discount_amount} ${snapshot.currency}`,
      315,
      y,
      { width: 240, align: "right" }
    );
    y += 15;
  }
  doc.text(`Total HT : ${snapshot.totals.total_ex_tax} ${snapshot.currency}`, 315, y, {
    width: 240,
    align: "right",
  });
  y += 15;
  doc.text(`TVA : ${snapshot.totals.total_tax} ${snapshot.currency}`, 315, y, {
    width: 240,
    align: "right",
  });
  y += 17;
  doc.font("Helvetica-Bold").fontSize(12);
  doc.text(`Total TTC : ${snapshot.totals.total_incl_tax} ${snapshot.currency}`, 315, y, {
    width: 240,
    align: "right",
  });
  y += 29;

  doc.font("Helvetica-Bold").fontSize(9).text("Échéances", 40, y);
  doc.font("Helvetica").fontSize(9);
  y += 15;
  for (const due of snapshot.due_dates) {
    doc.text(
      `${formatDate(due.due_date)} — ${due.label} — ${due.amount} ${snapshot.currency}`,
      40,
      y
    );
    y += 14;
  }

  if (snapshot.customer_text) {
    y += 10;
    doc.font("Helvetica-Bold").text("Informations client", 40, y);
    y += 14;
    doc.font("Helvetica").text(snapshot.customer_text, 40, y, { width: 515 });
  }

  doc
    .font("Helvetica")
    .fontSize(7)
    .fillColor("#667085")
    .text(
      `Document légal version 1 — instantané immuable ${snapshot.uuid}.`,
      40,
      doc.page.height - 48,
      { width: 515, align: "center" }
    );
}

async function buildPdf(snapshot: FinanceDocumentSnapshot): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 40, compress: true });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  renderSnapshot(doc, snapshot);
  doc.end();
  await new Promise<void>((resolve, reject) => {
    doc.once("end", resolve);
    doc.once("error", reject);
  });
  return Buffer.concat(chunks);
}

export async function writeImmutableFactureDocument(
  snapshot: FinanceDocumentSnapshot
): Promise<FinanceDocumentArtifact> {
  const documentId = crypto.randomUUID();
  const safeNumber = snapshot.legal_number.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const fileName = `Facture_${safeNumber}_v1.pdf`;
  const storageRoot = ensureDocumentStoragePath();
  const filePath = path.join(storageRoot, `${documentId}.pdf`);
  const pdf = await buildPdf(snapshot);
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
