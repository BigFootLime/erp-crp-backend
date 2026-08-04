import { describe, expect, it } from "vitest";

import {
  commandeArticleEligibleSql,
  commandeArticleEligibilityError,
  commandeArticleIneligibilityCodeSql,
  commandeArticleIneligibilityFromState,
} from "../module/stock/domain/commande-article-eligibility";

const BASE = {
  is_active: true,
  stock_managed: true,
  article_category: "fabrique",
  piece_technique_id: "11111111-1111-4111-8111-111111111111",
};

describe("BUG-CERP-0015 - predicat canonique d'eligibilite article", () => {
  it("accepte la categorie primaire fabriquee et sa valeur historique", () => {
    expect(commandeArticleIneligibilityFromState(BASE)).toBeNull();
    expect(
      commandeArticleIneligibilityFromState({ ...BASE, article_category: "PIECE_TECHNIQUE" })
    ).toBeNull();
  });

  it("reste fail-closed pour une matiere ayant seulement une categorie secondaire fabriquee", () => {
    expect(
      commandeArticleIneligibilityFromState({ ...BASE, article_category: "matiere" })
    ).toBe("ARTICLE_NOT_FABRICATED");

    const sql = commandeArticleEligibleSql("a");
    expect(sql).toContain("a.article_category IN ('fabrique', 'PIECE_TECHNIQUE')");
    expect(sql).not.toContain("article_category_link");
    expect(sql).not.toContain("piece_finie_fabriquee");
  });

  it.each([
    [{ ...BASE, is_active: false }, "ARTICLE_INACTIVE"],
    [{ ...BASE, stock_managed: false }, "ARTICLE_NOT_STOCK_MANAGED"],
    [{ ...BASE, article_category: "achat" }, "ARTICLE_NOT_FABRICATED"],
    [{ ...BASE, piece_technique_id: null }, "ARTICLE_PIECE_TECHNIQUE_REQUIRED"],
  ] as const)("classe chaque refus avant toute creation de ligne", (article, expected) => {
    expect(commandeArticleIneligibilityFromState(article)).toBe(expected);
  });

  it("garde le verdict et la raison SQL alignes", () => {
    const eligibleSql = commandeArticleEligibleSql("a");
    const reasonSql = commandeArticleIneligibilityCodeSql("a");
    for (const fragment of [
      "a.is_active",
      "a.stock_managed",
      "a.article_category IN ('fabrique', 'PIECE_TECHNIQUE')",
      "a.piece_technique_id",
    ]) {
      expect(eligibleSql).toContain(fragment);
      expect(reasonSql).toContain(fragment);
    }
  });

  it("retourne une erreur actionnable rattachee a la bonne ligne", () => {
    const error = commandeArticleEligibilityError({
      code: "ARTICLE_NOT_FABRICATED",
      articleId: "22222222-2222-4222-8222-222222222222",
      articleCode: "MAT-01",
      lineIndex: 2,
    });

    expect(error.status).toBe(409);
    expect(error.code).toBe("ARTICLE_NOT_FABRICATED");
    expect(error.message).toMatch(/MAT-01/);
    expect(error.details).toMatchObject({
      field: "lignes.2.article_id",
      line_index: 2,
      article_code: "MAT-01",
    });
  });
});
