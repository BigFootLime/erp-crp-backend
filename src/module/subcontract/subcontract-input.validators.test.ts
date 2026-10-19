import { describe, expect, it } from "vitest";
import {
  createSubcontractWorkPackageSchema,
  finaliseSubcontractWorkPackageSchema,
  subcontractLedgerSchema,
} from "./subcontract-input.validators";

const uuid = "11111111-1111-4111-8111-111111111111";

describe("subcontract input validators", () => {
  it("accepts existing valid payloads and normalizes their unit", () => {
    expect(createSubcontractWorkPackageSchema.parse({ supplier_order_line_id: uuid, of_operation_id: uuid, ged_evidence_document_id: uuid, unit: " pcs ", qty_planned: "4" })).toMatchObject({ unit: "PCS", qty_planned: 4 });
    expect(subcontractLedgerSchema.parse({ lot_id: uuid, unit: "kg", qty: 2 })).toMatchObject({ unit: "KG", qty: 2 });
    expect(finaliseSubcontractWorkPackageSchema.parse({ expected_row_version: "2", reason: "Réception contrôlée" })).toMatchObject({ expected_row_version: 2 });
  });

  it("refuses malformed, oversized and non-finite input", () => {
    expect(() => subcontractLedgerSchema.parse({ lot_id: "not-an-id", unit: "PCS", qty: 1 })).toThrow();
    expect(() => subcontractLedgerSchema.parse({ lot_id: uuid, unit: "X".repeat(33), qty: 1 })).toThrow();
    expect(() => finaliseSubcontractWorkPackageSchema.parse({ expected_row_version: 1, reason: "x".repeat(2_001) })).toThrow();
    expect(() => createSubcontractWorkPackageSchema.parse({ supplier_order_line_id: uuid, of_operation_id: uuid, ged_evidence_document_id: uuid, unit: "PCS", qty_planned: "Infinity" })).toThrow();
    for (const invalidNumber of [Infinity, -Infinity, Number.NaN, JSON.parse("1e999"), "1e999", "9".repeat(1_000)]) {
      expect(() => subcontractLedgerSchema.parse({ lot_id: uuid, unit: "PCS", qty: invalidNumber })).toThrow();
    }
    for (const invalidQuantity of [true, false, null, {}, []]) {
      expect(() => subcontractLedgerSchema.parse({ lot_id: uuid, unit: "PCS", qty: invalidQuantity })).toThrow();
    }
  });
});
