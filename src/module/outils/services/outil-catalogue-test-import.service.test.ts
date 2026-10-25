import { describe, expect, it } from "vitest";

import { planQualifiedCatalogueRecord } from "./outil-catalogue-test-import.service";

const source = {
  document: "catalogue.pdf",
  sha256: "a".repeat(64),
  page: 12,
  rect: [1, 2, 3, 4],
  selectionId: "catalogue-p12-r1",
};

describe("qualified catalogue test importer planning", () => {
  it("keeps a verified catalogue row pending physical inventory with zero ERP stock", () => {
    const plan = planQualifiedCatalogueRecord({
      manufacturer: "HORN", family: "Fraises", geometry: "Plate", reference: "DCG.3.M18",
      designation: null, source, stock: { state: "pending_inventory", quantity: null },
      dimensions: { diametre_nominal: 1.8, longueur_coupe: 3 },
      sourceSpecifications: { printedPitch: "M1,8", rawSeriesLine: "DCG.3.M18" },
      toolMaterial: "Carbure", coating: "TiAlN", utilisation: "Finition acier",
    });
    expect(plan.designation).toBe("Fraises DCG.3.M18");
    expect(plan.codification).toBe("HORN DCG.3.M18");
    expect(plan.source).toMatchObject({ selectionId: "catalogue-p12-r1", page: 12 });
    expect(plan.sourceSpecifications).toMatchObject({ printedPitch: "M1,8" });
    expect(plan.utilisation).toBe("Finition acier · Revêtement : TiAlN");
  });

  it("does not invent a counted quantity or accept a supplier stock claim", () => {
    expect(() => planQualifiedCatalogueRecord({
      manufacturer: "HORN", family: "Fraises", reference: "DCG.3.M18", source,
      stock: { state: "counted", quantity: 1 },
    })).toThrow("attente dâ€™inventaire");
  });

  it("rejects provenance that cannot satisfy the immutable four-coordinate evidence contract", () => {
    expect(() => planQualifiedCatalogueRecord({
      manufacturer: "DIXI", family: "Fraises", reference: "66149",
      source: { ...source, rect: [] }, stock: { state: "pending_inventory", quantity: null },
    })).toThrow("coordonnÃ©es source exactes");
  });

  it("uses a deterministic source-row identity only when the qualified row has no explicit selection anchor", () => {
    const plan = planQualifiedCatalogueRecord({
      manufacturer: "DIXI", family: "Fraises", reference: "66149",
      source: { ...source, selectionId: undefined, selectionAnchorId: undefined },
      stock: { state: "pending_inventory", quantity: null },
    });
    expect(plan.source.selectionId).toMatch(/^qualified-[a-f0-9]{40}$/);
  });
});


  it("validates mapped dimensions during dry-run", () => {
    expect(() => planQualifiedCatalogueRecord({
      manufacturer: "DIXI", family: "Fraises", reference: "66149", source,
      stock: { state: "pending_inventory", quantity: null }, dimensions: { diametre_nominal: "not-a-number" },
    })).toThrow("Dimension diametre_nominal invalide");
  });
