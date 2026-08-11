import { describe, expect, it } from "vitest";

import {
  buildOldMaterialDefinition,
  type OldMaterialDefinitionSource,
} from "../module/stock/domain/old-material-definition";

const base: OldMaterialDefinitionSource = {
  article_category: "matiere",
  designation: "",
  profile_code: "PL",
  nuance_code: null,
  etat_code: null,
  sous_etat_code: null,
  longueur_mm: null,
  largeur_mm: null,
  hauteur_mm: null,
  epaisseur_mm: null,
  diametre_mm: null,
};

describe("#446 Base OLD material definition", () => {
  it("derives the requested Clipper plate definition without changing its ART code", () => {
    expect(
      buildOldMaterialDefinition({
        ...base,
        designation: "ALUMINIUM 7075/T651 1 X 90 EP 30",
      })
    ).toBe("PL-7075-T651-1-90-30");
  });

  it("supports structured material data and keeps the historical segment order", () => {
    expect(
      buildOldMaterialDefinition({
        ...base,
        designation: "Plate structured",
        nuance_code: "7075",
        etat_code: "T651",
        sous_etat_code: "DETENSIONNE",
        longueur_mm: 1,
        largeur_mm: 115,
        epaisseur_mm: 25,
      })
    ).toBe("PL-7075-T651-DETENSIONNE-1-115-25");
  });

  it("uses length before diameter for a legacy round", () => {
    expect(
      buildOldMaterialDefinition({
        ...base,
        profile_code: "ROND",
        designation: "ALUMINIUM 7075/T6 Ø 20 L 1",
      })
    ).toBe("RO-7075-T6-1-20");
  });

  it("falls back to the technical code when the legacy definition is ambiguous", () => {
    expect(
      buildOldMaterialDefinition({
        ...base,
        designation: "INOX 303 1 X 50 EP 40",
      })
    ).toBeNull();
    expect(buildOldMaterialDefinition({ ...base, article_category: "fabrique" })).toBeNull();
  });
});
