import { describe, expect, it } from "vitest";
import { inspectCutoverRow, validateCutoverValues } from "./cutover-validation";
import { cutoverValuesSchema } from "../validators/data-cutover.validators";
import type { CutoverRow, CutoverValues } from "../types/data-cutover.types";

const salesOrder = (overrides: CutoverValues = {}): CutoverValues => ({
  customerCode: "CLI-001",
  customerOrderNumber: "BC-42",
  affairNumber: "AFF-23999",
  articleReference: "ART-001",
  quantityOrdered: "10",
  quantityDelivered: "2",
  quantityCancelled: "0",
  quantityRemaining: "8",
  stockReserved: "1",
  unit: "PC",
  unitPrice: "12.50",
  vatRate: "20",
  currency: "EUR",
  plannedDueDate: "2026-10-31",
  priceEvidence: "AR-42",
  ...overrides,
});

const row = (values: CutoverValues): CutoverRow => ({
  id: "00000000-0000-4000-8000-000000000001",
  batch_id: "00000000-0000-4000-8000-000000000002",
  domain: "ARTICLE",
  legacy_key: "ART-001",
  source_id: "fixture",
  sheet: "Articles",
  row_number: 2,
  source_values: {},
  values,
  source_issues: [],
  decision: "INCLUDE",
  review_note: "",
  version: 1,
  status: "READY",
  issues: [],
});

const codes = (issues: ReturnType<typeof validateCutoverValues>) => issues.map((issue) => issue.code);

describe("data cutover adversarial formats", () => {
  it("accepts real calendar dates and rejects impossible or non-canonical dates", () => {
    expect(codes(validateCutoverValues("METROLOGY", {
      equipmentReference: "EQ-01", designation: "Micromètre", equipmentStatus: "ACTIVE", nextCalibrationDate: "2028-02-29",
    }))).not.toContain("INVALID_DATE");
    for (const date of ["2026-02-29", "2026-13-01", "2026-00-10", "2026-1-1", "2026-10-01T00:00:00Z"]) {
      expect(codes(validateCutoverValues("METROLOGY", {
        equipmentReference: "EQ-01", designation: "Micromètre", equipmentStatus: "ACTIVE", nextCalibrationDate: date,
      }))).toContain("INVALID_DATE");
    }
  });

  it("rejects invalid email and SIRET, preserves a client code link, and rejects an invalid UUID target", () => {
    const customerIssues = validateCutoverValues("CUSTOMER", {
      customerCode: "CLI-001", name: "Client test", resolution: "LINK", targetId: "001", email: "bad@@mail", siret: "1234ABC",
    });
    expect(codes(customerIssues)).toEqual(expect.arrayContaining(["INVALID_EMAIL", "INVALID_SIRET"]));
    expect(codes(customerIssues)).not.toContain("INVALID_TARGET");
    const supplierIssues = validateCutoverValues("SUPPLIER", {
      supplierCode: "FOU-001", name: "Fournisseur test", resolution: "LINK", targetId: "not-a-uuid",
    });
    expect(codes(supplierIssues)).toContain("INVALID_TARGET");
  });

  it("normalizes a canonical unit only in an allowed context and blocks unknown units", () => {
    const valid = inspectCutoverRow(row({
      articleReference: "MAT-01", resolution: "CREATE", designation: "Matière", category: "matiere", unit: "pcs", familyCode: "MAT", lotTracked: true,
    }), { allowedUnits: ["u"] });
    expect(valid.values.unit).toBe("u");
    expect(valid.issues).toHaveLength(0);
    expect(codes(validateCutoverValues("ARTICLE", {
      articleReference: "MAT-01", designation: "Matière", category: "matiere", unit: "SAC-BIZARRE", familyCode: "MAT", lotTracked: true,
    }, [], "", { allowedUnits: ["u"] }))).toContain("UNKNOWN_STOCK_UNIT");
  });

  it("rejects scientific, NaN, excess precision, negative and zero quantities while accepting a decimal comma", () => {
    for (const value of ["1e3", "NaN", "12.1234567", "-1", "0"]) {
      expect(codes(validateCutoverValues("SALES_ORDER", salesOrder({ quantityOrdered: value })))).toEqual(expect.arrayContaining([
        value === "-1" ? "NEGATIVE_QUANTITY" : value === "0" ? "BELOW_MINIMUM" : "INVALID_DECIMAL",
      ]));
    }
    expect(codes(validateCutoverValues("SALES_ORDER", salesOrder({ quantityOrdered: "10,25", quantityDelivered: "2,25", quantityRemaining: "8" })))).not.toContain("INVALID_DECIMAL");
  });

  it("rejects reservations above stock and inconsistent remaining quantities", () => {
    expect(codes(validateCutoverValues("OPENING_STOCK", {
      stockScope: "OLD", articleReference: "MAT-01", quantityCounted: "2", quantityReserved: "3", unit: "PC", warehouse: "MAG", location: "A1", qualityStatus: "LIBERE", owner: "CRP", countEvidence: "Inventaire signé",
    }))).toContain("RESERVATION_EXCEEDS_STOCK");
    expect(codes(validateCutoverValues("SALES_ORDER", salesOrder({ quantityRemaining: "7", stockReserved: "9" })))).toEqual(expect.arrayContaining([
      "REMAINING_MISMATCH", "RESERVATION_EXCEEDS_REMAINING",
    ]));
  });
  it("does not accept a stock decimal that a native JavaScript number would round", () => {
    const stock = { stockScope: "OLD", stockKind: "MP", articleReference: "MAT-01", quantityCounted: "999999999998.999999", unit: "kg", warehouse: "MAG", location: "A1", qualityStatus: "LIBERE", owner: "CRP", countEvidence: "Inventaire signé" };
    expect(codes(validateCutoverValues("OPENING_STOCK", stock))).toContain("UNSAFE_DECIMAL");
    expect(codes(validateCutoverValues("OPENING_STOCK", { ...stock, quantityCounted: "1.000001" }))).not.toContain("UNSAFE_DECIMAL");
  });

  it("rejects unknown and prototype-polluting value keys before they reach catalog validation", () => {
    expect(cutoverValuesSchema.safeParse({ articleReference: "A", constructor: "x" }).success).toBe(false);
    expect(cutoverValuesSchema.safeParse(JSON.parse('{"articleReference":"A","__proto__":"x"}')).success).toBe(false);
    expect(codes(validateCutoverValues("ARTICLE", {
      articleReference: "A", designation: "Article", category: "achat", unit: "PC", familyCode: "ACH", lotTracked: false, injected: "x",
    }))).toContain("UNKNOWN_FIELD");
  });
});
