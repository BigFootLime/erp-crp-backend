import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createArticleSchema,
  createLotSchema,
  createMatiereNuanceSchema,
} from "../module/stock/validators/stock.validators";
import {
  createCatalogueSchema,
  updateCatalogueSchema,
} from "../module/fournisseurs/validators/fournisseurs.validators";
import {
  previewFinishBodySchema,
  stockArticleFinishPreviewBodySchema,
} from "../module/surface-finish/validators/surface-finish.validators";
import {
  ARTICLE_APPROVE_ROLES,
  ARTICLE_WRITE_ROLES,
} from "../module/stock/stock-article.permissions";

const PT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const REVISION_ID = "33333333-3333-4333-8333-333333333333";
const ARTICLE_ID = "44444444-4444-4444-8444-444444444444";
const profiles = ["PL", "RO", "U", "FOND", "TUBE", "PROFIL", "BRUTCL"] as const;

function materialBody(profile: typeof profiles[number]) {
  return {
    body: {
      designation: `Matière ${profile}`,
      article_category: "matiere",
      article_categories: ["matiere_premiere"],
      family_code: profile,
      article_matiere: profile === "BRUTCL"
        ? { client_proprietaire_id: "001" }
        : {},
    },
  };
}

describe("#164 profils matière et dimensions restantes", () => {
  it.each(profiles)("accepte le profil canonique %s", (profile) => {
    expect(createArticleSchema.safeParse(materialBody(profile)).success).toBe(true);
  });

  it("exige le client propriétaire du BRUTCL et conserve son identifiant", () => {
    const missingOwner = materialBody("BRUTCL");
    missingOwner.body.article_matiere = {};
    expect(createArticleSchema.safeParse(missingOwner).success).toBe(false);

    const parsed = createArticleSchema.parse(materialBody("BRUTCL"));
    expect(parsed.body.article_matiere?.client_proprietaire_id).toBe("001");
  });

  it("accepte largeur/épaisseur absentes et une barre à découper sans longueur théorique", () => {
    const input = materialBody("U");
    input.body.article_matiere = {
      barre_a_decouper: true,
      longueur_coupe_mm: 42,
      quantite_lineaire_totale_mm: 12_500,
    };
    const parsed = createArticleSchema.parse(input);
    expect(parsed.body.article_matiere?.longueur_barre_source_mm).toBeUndefined();
    expect(parsed.body.article_matiere?.longueur_coupe_mm).toBe(42);
    expect(parsed.body.article_matiere?.largeur_mm).toBeUndefined();
    expect(parsed.body.article_matiere?.epaisseur_mm).toBeUndefined();
  });

  it("distingue barre source, coupe, brut et quantité linéaire", () => {
    const input = materialBody("TUBE");
    input.body.article_matiere = {
      longueur_barre_source_mm: 6_000,
      longueur_coupe_mm: 120,
      longueur_brut_mm: 125,
      quantite_lineaire_totale_mm: 24_000,
    };
    const parsed = createArticleSchema.parse(input).body.article_matiere;
    expect(parsed).toMatchObject({
      longueur_barre_source_mm: 6_000,
      longueur_coupe_mm: 120,
      longueur_brut_mm: 125,
      quantite_lineaire_totale_mm: 24_000,
    });
  });

  it("porte la quantité linéaire totale au niveau du lot sans toucher aux mouvements", () => {
    const parsed = createLotSchema.parse({
      body: { article_id: ARTICLE_ID, quantite_lineaire_totale_mm: 18_000 },
    });
    expect(parsed.body.quantite_lineaire_totale_mm).toBe(18_000);
  });
});

describe("#164 nuances et unité canonique de densité", () => {
  it("accepte une nuance sans désignation", () => {
    const parsed = createMatiereNuanceSchema.parse({
      body: { code: "42CD4", densite: 7_850 },
    });
    expect(parsed.body.designation).toBeNull();
    expect(parsed.body.densite).toBe(7_850);
  });

  it("refuse le code manquant et une densité encore exprimée en kg/dm³", () => {
    expect(createMatiereNuanceSchema.safeParse({ body: { densite: 7_850 } }).success).toBe(false);
    expect(createMatiereNuanceSchema.safeParse({ body: { code: "S235", densite: 7.85 } }).success).toBe(false);
  });
});

describe("#164 catégorie et tarification fournisseur", () => {
  it("refuse toute catégorie d'article implicite, notamment PF", () => {
    expect(createArticleSchema.safeParse({
      body: { designation: "Sans catégorie", family_code: "PT" },
    }).success).toBe(false);
  });

  it.each(["NONE", "KG", "M"] as const)("accepte la base de prix exclusive %s", (pricing_basis) => {
    const parsed = createCatalogueSchema.parse({
      body: {
        type: "MATIERE",
        designation: "Barre acier",
        prix_unitaire: 2.5,
        pricing_basis,
      },
    });
    expect(parsed.body.pricing_basis).toBe(pricing_basis);
  });

  it("refuse une base ambiguë ou inventée", () => {
    expect(updateCatalogueSchema.safeParse({
      body: { pricing_basis: "KG/M" },
    }).success).toBe(false);
  });
});

describe("#164 contrats PT/Stock et séparation des droits", () => {
  it("ne redemande pas la PT/version depuis le contrat nomenclature", () => {
    expect(previewFinishBodySchema.safeParse({
      finish_revision_id: REVISION_ID,
    }).success).toBe(true);
  });

  it("exige PT et version depuis Stock", () => {
    expect(stockArticleFinishPreviewBodySchema.safeParse({
      finish_revision_id: REVISION_ID,
    }).success).toBe(false);
    expect(stockArticleFinishPreviewBodySchema.safeParse({
      piece_technique_id: PT_ID,
      piece_technique_version_id: VERSION_ID,
      finish_revision_id: REVISION_ID,
    }).success).toBe(true);
  });

  it("sépare le droit de créer d'un droit de valider/mise en production", () => {
    expect(ARTICLE_WRITE_ROLES).toContain("Stock");
    expect(ARTICLE_APPROVE_ROLES).not.toContain("Stock");
    expect(ARTICLE_APPROVE_ROLES).toContain("Responsable Qualité");
  });
});

describe("#164 migration restante", () => {
  const patch = readFileSync(
    resolve("db/patches/20260729_articles_164_remaining_rules.sql"),
    "utf8"
  );
  const preflight = readFileSync(
    resolve("db/patches/support/20260729_articles_164_remaining_rules.preflight.sql"),
    "utf8"
  );
  const verify = readFileSync(
    resolve("db/patches/support/20260729_articles_164_remaining_rules.verify.sql"),
    "utf8"
  );
  const rollback = readFileSync(
    resolve("db/patches/support/20260729_articles_164_remaining_rules.rollback.sql"),
    "utf8"
  );

  it("convertit 7,85 kg/dm³ en 7 850 kg/m³ sans supprimer la colonne historique", () => {
    expect(patch).toContain("densite_kg_m3 = round(densite * 1000, 3)");
    expect(patch).not.toMatch(/DROP COLUMN IF EXISTS densite\b/i);
    expect(verify).toContain("conversion_example_7_85_to_7850");
  });

  it("contraint l'unicité normalisée du code nuance et les trois bases de prix", () => {
    expect(patch).toContain("stock_nuances_code_normalized_uq");
    expect(patch).toContain("upper(btrim(code))");
    expect(patch).toContain("pricing_basis IN ('NONE', 'KG', 'M')");
  });

  it("préserve lots et mouvements et fournit un préflight lecture seule", () => {
    expect(preflight).toContain("lots_before");
    expect(preflight).toContain("movement_lines_before");
    expect(verify).toContain("lots_after");
    expect(verify).toContain("movement_lines_after");
    expect(preflight).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/im);
  });

  it("interdit le rollback structurel hors cerp_test", () => {
    expect(rollback).toContain("current_database() <> 'cerp_test'");
    expect(rollback).toContain("Rollback #164 interdit");
  });

  it("ne duplique pas le moteur de finitions", () => {
    const repository = readFileSync(
      resolve("src/module/surface-finish/repository/surface-finish-resolution.repository.ts"),
      "utf8"
    );
    expect(repository).toContain("resolveOperationSpec(revision, body.overrides)");
    expect(repository).toContain("buildCanonicalFinishSpec");
    expect(repository).toContain("generateTexts");
    expect(repository.match(/repoPreviewStockFinishArticle/g)).toHaveLength(1);
  });
});
