import { describe, expect, it } from "vitest";
import { articleReconfigurationSchema } from "./article-reconfiguration.validators";

describe("contrat reconfiguration", () => {
  const base = { expected_row_version: 1, action: "KEEP_BOTH", article: { article_category: "matiere", family_code: "PL", article_matiere: { largeur_mm: 95 } } };
  it("réutilise le contrat de configuration matière", () => expect(articleReconfigurationSchema.safeParse(base).success).toBe(true));
  it("exige le choix et une version attendue", () => {
    expect(articleReconfigurationSchema.safeParse({ ...base, action: undefined }).success).toBe(false);
    expect(articleReconfigurationSchema.safeParse({ ...base, expected_row_version: undefined }).success).toBe(false);
  });
  it("refuse une validation sans configuration ou avec deux configurateurs", () => {
    expect(articleReconfigurationSchema.safeParse({ ...base, article: undefined }).success).toBe(false);
    expect(articleReconfigurationSchema.safeParse({ ...base, finish: {} }).success).toBe(false);
  });
  it("ne permet pas de contourner le configurateur et les droits de finition", () => {
    expect(articleReconfigurationSchema.safeParse({ ...base, article: {
      article_category: "traitement", family_code: "TS", designation: "Procédé arbitraire",
    } }).success).toBe(false);
  });
});
