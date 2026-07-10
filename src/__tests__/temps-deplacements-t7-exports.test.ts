import { describe, expect, it } from "vitest";
import {
  buildPayrollCsv,
  buildPayrollPdf,
  minutesToDecimalHours,
  payrollRowToCsvCells,
  sha256Hex,
  toCsv,
  type PayrollWeekRow,
} from "../module/temps-deplacements/services/temps-deplacements-exports";

const row: PayrollWeekRow = {
  matricule: "TD001", name: "Jean", surname: "Dupont", week_start: "2026-03-02", week_end: "2026-03-08",
  worked_minutes: 2400, contract_minutes: 2100, overtime_25_minutes: 300, overtime_50_minutes: 0, absence_minutes: 0,
};

describe("T7 — CSV (séparateur ; + BOM UTF-8 + échappement)", () => {
  it("préfixe le BOM UTF-8 et sépare par ;", () => {
    const csv = toCsv(["A", "B"], [["1", "2"]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff); // BOM
    expect(csv).toContain("A;B\r\n");
    expect(csv.endsWith("\r\n")).toBe(true);
  });
  it("échappe les champs contenant ; \" ou saut de ligne", () => {
    expect(toCsv(["X"], [["a;b"]])).toContain('"a;b"');
    expect(toCsv(["X"], [['il a dit "oui"']])).toContain('"il a dit ""oui"""');
  });
  it("minutes → heures décimales", () => {
    expect(minutesToDecimalHours(90)).toBe("1.50");
    expect(minutesToDecimalHours(2100)).toBe("35.00");
    expect(minutesToDecimalHours(0)).toBe("0.00");
  });
  it("ligne paie → cellules, CSV complet avec en-tête", () => {
    expect(payrollRowToCsvCells(row)).toEqual(["TD001", "Dupont", "Jean", "2026-03-02", "2026-03-08", "40.00", "35.00", "5.00", "0.00", "0.00"]);
    const csv = buildPayrollCsv([row]);
    expect(csv).toContain("Matricule;Nom;Prénom");
    expect(csv).toContain("TD001;Dupont;Jean;2026-03-02;2026-03-08;40.00;35.00;5.00;0.00;0.00");
  });
});

describe("T7 — checksum SHA-256 déterministe", () => {
  it("hache de façon stable et connue", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const csv = buildPayrollCsv([row]);
    expect(sha256Hex(csv)).toBe(sha256Hex(csv)); // reproductible
  });
});

describe("T7 — PDF (pdfkit, sans dépendance Excel)", () => {
  it("produit un buffer PDF valide (%PDF)", async () => {
    const buf = await buildPayrollPdf({ periodStart: "2026-03-01", periodEnd: "2026-03-31" }, [row]);
    expect(buf.length).toBeGreaterThan(100);
    expect(buf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });
});
