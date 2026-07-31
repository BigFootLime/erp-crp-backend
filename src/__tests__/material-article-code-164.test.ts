import { describe, expect, it } from "vitest";

import {
  assertMaterialPreviewFresh,
  buildMaterialArticleCode,
  buildMaterialDimensionsSegment,
  computeMaterialCodePreviewHash,
  isSpecialMaterialProfile,
  normalizeMaterialProfile,
  MATERIAL_PROFILE_CODES,
} from "../shared/codes/material-article-code";
import { createArticleSchema, previewMaterialArticleCodeSchema } from "../module/stock/validators/stock.validators";

/**
 * #164 — La référence matière est produite par le SERVEUR.
 *
 * Ces tests figent la règle : aperçu et création appellent la même fonction,
 * aucune valeur n'est inventée quand une donnée manque, et un profil inconnu
 * est refusé au lieu de produire une référence illisible.
 */
describe("Référence matière — profils", () => {
  it("expose exactement les sept profils du besoin", () => {
    expect([...MATERIAL_PROFILE_CODES]).toEqual(["PL", "RO", "U", "FOND", "TUBE", "PROFIL", "BRUTCL"]);
  });

  it("ramène les orthographes historiques au code canonique", () => {
    expect(normalizeMaterialProfile("plat")).toBe("PL");
    expect(normalizeMaterialProfile("TÔLE")).toBe("PL");
    expect(normalizeMaterialProfile("Rond")).toBe("RO");
    expect(normalizeMaterialProfile("brut-client")).toBe("BRUTCL");
    expect(normalizeMaterialProfile("FONDERIE")).toBe("FOND");
  });

  it("refuse un profil inconnu plutôt que d'inventer un code", () => {
    expect(() => normalizeMaterialProfile("XYZ")).toThrowError(/Profil matière inconnu/);
    expect(() => normalizeMaterialProfile("")).toThrowError(/Profil matière inconnu/);
  });

  it("classe FOND, PROFIL et BRUTCL comme profils sans géométrie identifiante", () => {
    expect(isSpecialMaterialProfile("FOND")).toBe(true);
    expect(isSpecialMaterialProfile("PROFIL")).toBe(true);
    expect(isSpecialMaterialProfile("BRUTCL")).toBe(true);
    expect(isSpecialMaterialProfile("PL")).toBe(false);
  });
});

describe("Référence matière — segment dimensionnel", () => {
  it("ordonne les cotes par profil", () => {
    expect(
      buildMaterialDimensionsSegment("PL", { largeur_mm: 100, epaisseur_mm: 10, longueur_brut_mm: 3000 })
    ).toBe("100x10x3000");
    expect(buildMaterialDimensionsSegment("RO", { diametre_mm: 20, longueur_brut_mm: 3000 })).toBe("20x3000");
    expect(
      buildMaterialDimensionsSegment("TUBE", { diametre_mm: 30, epaisseur_mm: 2, longueur_coupe_mm: 1000 })
    ).toBe("30x2x1000");
    expect(
      buildMaterialDimensionsSegment("U", { largeur_mm: 50, hauteur_mm: 40, epaisseur_mm: 5 })
    ).toBe("50x40x5");
  });

  it("omet une cote absente au lieu de la combler", () => {
    expect(buildMaterialDimensionsSegment("PL", { largeur_mm: 100 })).toBe("100");
    expect(buildMaterialDimensionsSegment("PL", {})).toBeNull();
    expect(buildMaterialDimensionsSegment("RO", { diametre_mm: 0 })).toBeNull();
  });

  it("exclut la longueur d'une barre à découper : elle varie d'une réception à l'autre", () => {
    expect(
      buildMaterialDimensionsSegment("RO", {
        diametre_mm: 20,
        barre_a_decouper: true,
        longueur_barre_source_mm: 6000,
        longueur_brut_mm: 6000,
      })
    ).toBe("20");
  });

  it("n'attribue aucune dimension aux profils particuliers", () => {
    expect(buildMaterialDimensionsSegment("FOND", { largeur_mm: 10 })).toBeNull();
    expect(buildMaterialDimensionsSegment("BRUTCL", { largeur_mm: 10 })).toBeNull();
  });
});

describe("Référence matière — code et désignation canonique", () => {
  it("construit la référence d'un plat complet", () => {
    const out = buildMaterialArticleCode({
      profile: "PL",
      nuance_code: "S235",
      etat_code: "BRUT",
      dimensions: { largeur_mm: 100, epaisseur_mm: 10, longueur_brut_mm: 3000 },
    });
    expect(out.code).toBe("MP-PL-S235-BRUT-100x10x3000");
    expect(out.designation).toBe("PLAT/TOLE S235 BRUT 100x10x3000 mm");
  });

  it("insère le sous-état quand il est choisi", () => {
    const out = buildMaterialArticleCode({
      profile: "RO",
      nuance_code: "316L",
      etat_code: "RECT",
      sous_etat_code: "H9",
      dimensions: { diametre_mm: 20, longueur_brut_mm: 3000 },
    });
    expect(out.code).toBe("MP-RO-316L-RECT-H9-20x3000");
  });

  it("accepte une matière sans aucune cote : le code reste lisible, sans segment inventé", () => {
    const out = buildMaterialArticleCode({ profile: "PL", nuance_code: "S235", etat_code: "BRUT" });
    expect(out.code).toBe("MP-PL-S235-BRUT");
    expect(out.dimensions_segment).toBeNull();
  });

  it("normalise les séparateurs sans écraser les groupes métier", () => {
    const out = buildMaterialArticleCode({
      profile: "PL",
      nuance_code: "s 235 jr",
      etat_code: "brut/lamine",
      dimensions: { largeur_mm: 100, epaisseur_mm: 10 },
    });
    expect(out.code).toBe("MP-PL-S-235-JR-BRUT-LAMINE-100x10");
  });

  it("exige nuance et état pour un profil géométrique", () => {
    expect(() => buildMaterialArticleCode({ profile: "PL", etat_code: "BRUT" })).toThrowError(/nuance/i);
    expect(() => buildMaterialArticleCode({ profile: "PL", nuance_code: "S235" })).toThrowError(/état/i);
  });

  it("exige une référence métier pour FOND et PROFIL", () => {
    expect(() => buildMaterialArticleCode({ profile: "FOND" })).toThrowError(/référence métier/i);
    expect(buildMaterialArticleCode({ profile: "FOND", reference_suffix: "CARTER-12" }).code).toBe(
      "MP-FOND-CARTER-12"
    );
    expect(buildMaterialArticleCode({ profile: "PROFIL", reference_suffix: "omega 45" }).code).toBe(
      "MP-PROFIL-OMEGA-45"
    );
  });

  it("exige le code client ET la référence pour un brut client", () => {
    expect(() => buildMaterialArticleCode({ profile: "BRUTCL", reference_suffix: "AX12" })).toThrowError(
      /code du client propriétaire/i
    );
    const out = buildMaterialArticleCode({
      profile: "BRUTCL",
      client_code: "CLI-042",
      reference_suffix: "AX12",
    });
    expect(out.code).toBe("MP-BRUTCL-CLI-042-AX12");
    expect(out.designation).toBe("BRUT CLIENT CLI-042 AX12");
  });
});

describe("Référence matière — empreinte d'aperçu", () => {
  const input = {
    profile: "PL" as const,
    nuance_code: "S235",
    etat_code: "BRUT",
    dimensions: { largeur_mm: 100, epaisseur_mm: 10, longueur_brut_mm: 3000 },
  };

  it("est stable pour une configuration identique", () => {
    const result = buildMaterialArticleCode(input);
    const a = computeMaterialCodePreviewHash({ input, code: result.code, designation: result.designation });
    const b = computeMaterialCodePreviewHash({ input, code: result.code, designation: result.designation });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("change dès qu'une cote change", () => {
    const first = buildMaterialArticleCode(input);
    const second = buildMaterialArticleCode({ ...input, dimensions: { ...input.dimensions, largeur_mm: 120 } });
    expect(
      computeMaterialCodePreviewHash({ input, code: first.code, designation: first.designation })
    ).not.toBe(
      computeMaterialCodePreviewHash({
        input: { ...input, dimensions: { ...input.dimensions, largeur_mm: 120 } },
        code: second.code,
        designation: second.designation,
      })
    );
  });

  it("refuse une confirmation dont l'aperçu est périmé, tolère un client qui n'en envoie pas", () => {
    expect(() => assertMaterialPreviewFresh(undefined, "a".repeat(64))).not.toThrow();
    expect(() => assertMaterialPreviewFresh("", "a".repeat(64))).not.toThrow();
    expect(() => assertMaterialPreviewFresh("b".repeat(64), "a".repeat(64))).toThrowError(/plus à jour/);
  });
});

describe("Contrat HTTP", () => {
  it("accepte une matière SANS désignation : le serveur produit la forme canonique", () => {
    const parsed = createArticleSchema.safeParse({
      body: {
        article_category: "matiere",
        family_code: "PL",
        article_matiere: { nuance_id: 1, etat_id: 2, largeur_mm: 100, epaisseur_mm: 10 },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("continue d'exiger une désignation hors matière", () => {
    const parsed = createArticleSchema.safeParse({
      body: { article_category: "achat", family_code: "ACH" },
    });
    expect(parsed.success).toBe(false);
  });

  it("refuse une empreinte d'aperçu matière sur une autre catégorie", () => {
    const parsed = createArticleSchema.safeParse({
      body: {
        designation: "Écrou",
        article_category: "achat",
        family_code: "ACH",
        material_code_preview_hash: "a".repeat(64),
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepte la configuration matière complète pour l'aperçu", () => {
    const parsed = previewMaterialArticleCodeSchema.safeParse({
      body: {
        family_code: "BRUTCL",
        client_proprietaire_id: "042",
        reference_suffix: "AX12",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("refuse un champ inconnu dans l'aperçu (schéma strict)", () => {
    const parsed = previewMaterialArticleCodeSchema.safeParse({
      body: { family_code: "PL", code: "MP-PL-FORGE" },
    });
    expect(parsed.success).toBe(false);
  });
});
