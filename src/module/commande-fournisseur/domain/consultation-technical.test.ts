import { describe, expect, it } from "vitest";
import {
  assertConsultationSnapshotCurrent,
  supplierConsultationRequest,
  type ConsultationSnapshot,
  type ConsultationTechnicalSource,
} from "./supplier-consultation";

const source: ConsultationTechnicalSource = {
  line_id: "line",
  of_id: 1,
  of_code: "OF-A",
  piece_technique_id: "pt",
  piece_code: "PIECE-A",
  designation: "Pièce A",
  version_id: "v1",
  plan_reference: "PLAN-A",
  external_index: "A",
  internal_version: 1,
  critical: false,
  required_documents: [
    {
      code: "CERTIFICAT_MP",
      label: "Certificat matière",
      policy: "REQUIRED_FOR_ALL_LINKED_PT",
    },
  ],
  manufacturing_frozen: true,
  manufacturing_sha256: "a".repeat(64),
  source_sha256: "1".repeat(64),
};
const snapshot: ConsultationSnapshot = {
  code: "CF-A",
  currency: "EUR",
  delivery_address: null,
  destination_id: null,
  freight_vat_pct: 20,
  lines: [
    {
      id: "line",
      designation: "Prestation",
      article_id: null,
      article_code: null,
      quantity: 100,
      unit: "U",
      stock_unit: null,
      coefficient: null,
      vat_pct: 20,
      need_date: null,
      requirements: [],
      documents: [],
      operation: "Traitement",
      of_id: 1,
    },
  ],
  technical_sources: [source],
};

describe("consultation technical evidence", () => {
  it("accepts an unchanged snapshot even after JSON object keys are reordered", () => {
    const reordered = Object.fromEntries(
      Object.entries(source).reverse(),
    ) as ConsultationTechnicalSource;
    expect(() =>
      assertConsultationSnapshotCurrent(snapshot, {
        ...snapshot,
        technical_sources: [reordered],
      }),
    ).not.toThrow();
  });
  it("refuses a changed technical source without a purchase header change", () => {
    expect(() =>
      assertConsultationSnapshotCurrent(snapshot, {
        ...snapshot,
        technical_sources: [{ ...source, source_sha256: "2".repeat(64) }],
      }),
    ).toThrow("dossier OF ont changé");
  });
  it("refuses a changed index and a changed second recipient", () => {
    const grouped = {
      ...snapshot,
      technical_sources: [source, { ...source, of_id: 2, of_code: "OF-B" }],
    };
    expect(() =>
      assertConsultationSnapshotCurrent(grouped, {
        ...grouped,
        technical_sources: [
          source,
          { ...source, of_id: 2, of_code: "OF-B", external_index: "B" },
        ],
      }),
    ).toThrow();
  });
  it("does not manufacture technical evidence for a legacy production round", () => {
    const legacy = { ...snapshot };
    delete legacy.technical_sources;
    expect(() => assertConsultationSnapshotCurrent(legacy, snapshot)).toThrow(
      "ancienne consultation",
    );
    expect(legacy.technical_sources).toBeUndefined();
  });
  it("preserves old global-consumable rounds with no production recipient", () => {
    const legacy = { ...snapshot };
    delete legacy.technical_sources;
    expect(() =>
      assertConsultationSnapshotCurrent(legacy, {
        ...legacy,
        technical_sources: [],
      }),
    ).not.toThrow();
  });
  it("prepares all grouped references and marks a prospective dossier explicitly", () => {
    const text = supplierConsultationRequest(
      {
        ...snapshot,
        technical_sources: [
          source,
          { ...source, of_id: 2, of_code: "OF-B", manufacturing_frozen: false },
        ],
      },
      "Fournisseur",
      "",
    );
    expect(text).toContain("OF-A");
    expect(text).toContain("OF-B");
    expect(text).toContain("plan PLAN-A · indice A · version 1");
    expect(text).toContain("Certificat matière");
    expect(text).toContain("dossier de fabrication en préparation");
  });
});
