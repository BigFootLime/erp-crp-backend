import crypto from "node:crypto";
import { renderCerpDocument } from "../../../shared/pdf/cerp-document";

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
 const created=new Date();
 return renderCerpDocument({module:"systeme",documentType:"Récapitulatif temps — paie",name:meta.periodStart+" au "+meta.periodEnd,
   code:null,status:"Récapitulatif",generatedAt:created.toLocaleDateString("fr-FR",{timeZone:"Europe/Paris"}),
   title:"Récapitulatif temps — paie",subject:"Temps et heures supplémentaires de la période",creationDate:created},ctx=>{
   ctx.linesTable({columns:[{key:"id",label:"Matricule",flex:1},{key:"name",label:"Salarié",flex:2},{key:"week",label:"Semaine",flex:1.2},
     {key:"work",label:"Trav.",flex:.8},{key:"contract",label:"Contrat",flex:.8},{key:"hs25",label:"HS25",flex:.7},{key:"hs50",label:"HS50",flex:.7},{key:"absence",label:"Abs.",flex:.7}],
     rows:rows.map(r=>({cells:{id:r.matricule,name:(r.surname??"")+" "+(r.name??""),week:r.week_start,
       work:minutesToDecimalHours(r.worked_minutes),contract:minutesToDecimalHours(r.contract_minutes),hs25:minutesToDecimalHours(r.overtime_25_minutes),
       hs50:minutesToDecimalHours(r.overtime_50_minutes),absence:minutesToDecimalHours(r.absence_minutes)}})),emptyLabel:"Aucune ligne sur la période."});
 });
}
