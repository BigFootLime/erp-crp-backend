import crypto from "node:crypto";
import PDFDocument from "pdfkit";

// T7 — Générateurs d'export PURS (CSV `;` + BOM UTF-8, PDF récap) + checksum. Aucune dépendance Excel/XLSX.

export interface PayrollWeekRow {
  matricule: string;
  name: string | null;
  surname: string | null;
  week_start: string;
  week_end: string;
  worked_minutes: number;
  contract_minutes: number;
  overtime_25_minutes: number;
  overtime_50_minutes: number;
  absence_minutes: number;
}

export const CSV_HEADER = [
  "Matricule", "Nom", "Prénom", "Début semaine", "Fin semaine",
  "H. travaillées", "H. contractuelles", "HS 25%", "HS 50%", "H. absence",
] as const;

// Minutes → heures décimales (point), 2 décimales. 90 → "1.50".
export function minutesToDecimalHours(min: number): string {
  return (min / 60).toFixed(2);
}

export function payrollRowToCsvCells(r: PayrollWeekRow): string[] {
  return [
    r.matricule,
    r.surname ?? "",
    r.name ?? "",
    r.week_start,
    r.week_end,
    minutesToDecimalHours(r.worked_minutes),
    minutesToDecimalHours(r.contract_minutes),
    minutesToDecimalHours(r.overtime_25_minutes),
    minutesToDecimalHours(r.overtime_50_minutes),
    minutesToDecimalHours(r.absence_minutes),
  ];
}

// Échappement CSV : guillemets si le champ contient ; " CR ou LF.
function escapeCsv(value: string): string {
  const s = String(value ?? "");
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV français : séparateur `;`, BOM UTF-8, fins de ligne CRLF (compatible tableurs FR).
export function toCsv(header: readonly string[], rows: string[][]): string {
  const lines = [header as readonly string[], ...rows].map((r) => r.map((c) => escapeCsv(String(c))).join(";"));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export function buildPayrollCsv(rows: PayrollWeekRow[]): string {
  return toCsv(CSV_HEADER, rows.map(payrollRowToCsvCells));
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

// PDF récapitulatif (pdfkit, police Helvetica intégrée — aucun fichier de police requis).
export function buildPayrollPdf(meta: { periodStart: string; periodEnd: string }, rows: PayrollWeekRow[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 36, size: "A4" });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.fontSize(15).text("Récapitulatif temps — paie", { align: "left" });
      doc.moveDown(0.3).fontSize(10).fillColor("#555").text(`Période : ${meta.periodStart} → ${meta.periodEnd}`);
      doc.fillColor("#000").moveDown(0.8);

      const cols = ["Matricule", "Salarié", "Semaine", "Trav.", "Contrat", "HS25", "HS50", "Abs."];
      const widths = [70, 130, 90, 45, 50, 40, 40, 45];
      const startX = doc.x;
      let y = doc.y;
      const drawRow = (cells: string[], bold: boolean) => {
        doc.fontSize(8).font(bold ? "Helvetica-Bold" : "Helvetica");
        let x = startX;
        cells.forEach((c, i) => {
          doc.text(c, x + 2, y + 2, { width: widths[i] - 4, ellipsis: true });
          x += widths[i];
        });
        y += 16;
        if (y > 780) { doc.addPage(); y = doc.y; }
      };
      drawRow([...cols], true);
      for (const r of rows) {
        drawRow(
          [
            r.matricule,
            `${r.surname ?? ""} ${r.name ?? ""}`.trim(),
            r.week_start,
            minutesToDecimalHours(r.worked_minutes),
            minutesToDecimalHours(r.contract_minutes),
            minutesToDecimalHours(r.overtime_25_minutes),
            minutesToDecimalHours(r.overtime_50_minutes),
            minutesToDecimalHours(r.absence_minutes),
          ],
          false
        );
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
