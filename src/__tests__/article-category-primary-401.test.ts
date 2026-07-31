import { describe, expect, it, vi } from "vitest";

vi.mock("pg", () => ({
  Pool: class {
    on = vi.fn();
    query = vi.fn();
    connect = vi.fn();
  },
}));

vi.mock("dotenv", () => ({ default: { config: vi.fn() } }));

import {
  normalizeArticleCategorySelection,
  syncArticleSubtypeDetails,
} from "../module/stock/repository/stock.repository";
import { createArticleSchema, updateArticleSchema } from "../module/stock/validators/stock.validators";

const PT_ID = "11111111-1111-4111-8111-111111111111";

const validCases = [
  {
    label: "PF fabriquée",
    body: {
      designation: "Pièce fabriquée",
      article_category: "fabrique" as const,
      article_categories: ["piece_finie_fabriquee" as const],
      family_code: "PT",
      piece_technique_id: PT_ID,
    },
  },
  {
    label: "matière première",
    body: {
      designation: "Rond acier",
      article_category: "matiere" as const,
      article_categories: ["matiere_premiere" as const],
      family_code: "RO",
      article_matiere: {},
    },
  },
  {
    label: "traitement de surface",
    body: {
      designation: "Anodisation noire",
      article_category: "traitement" as const,
      article_categories: ["traitement_surface" as const],
      family_code: "TRT",
    },
  },
  {
    label: "achat-revente",
    body: {
      designation: "Vis standard",
      article_category: "achat" as const,
      article_categories: ["achat_revente" as const],
      family_code: "ACH",
    },
  },
  {
    label: "achat-transformé",
    body: {
      designation: "Brut transformé",
      article_category: "achat" as const,
      article_categories: ["achat_transforme" as const],
      family_code: "ACH",
    },
  },
  {
    label: "sous-traitance",
    body: {
      designation: "Usinage sous-traité",
      article_category: "achat" as const,
      article_categories: ["sous_traitance" as const],
      family_code: "ACH",
    },
  },
];

describe("#401 catégorie primaire Article", () => {
  it.each(validCases)("accepte la création $label sans champ d'une autre catégorie", ({ body }) => {
    expect(createArticleSchema.safeParse({ body }).success).toBe(true);
  });

  it("conserve la catégorie primaire explicite malgré des usages secondaires contradictoires", () => {
    const selection = normalizeArticleCategorySelection("achat", [
      "piece_finie_fabriquee",
      "matiere_premiere",
      "sous_traitance",
    ]);

    expect(selection.article_category).toBe("achat");
    expect(selection.article_categories).toEqual([
      "achat_revente",
      "piece_finie_fabriquee",
      "matiere_premiere",
      "sous_traitance",
    ]);
  });

  it("place le code métier associé à la catégorie primaire en première position", () => {
    expect(normalizeArticleCategorySelection("traitement", ["achat_revente"]).article_categories).toEqual([
      "traitement_surface",
      "achat_revente",
    ]);
    expect(normalizeArticleCategorySelection("matiere", ["achat_transforme"]).article_categories).toEqual([
      "matiere_premiere",
      "achat_transforme",
    ]);
  });

  it("interdit une PT hors PF et exige une PT pour une PF", () => {
    expect(createArticleSchema.safeParse({
      body: { ...validCases[2].body, piece_technique_id: PT_ID },
    }).success).toBe(false);
    expect(createArticleSchema.safeParse({
      body: { designation: "PF incomplète", article_category: "fabrique", family_code: "PT" },
    }).success).toBe(false);
  });

  it("accepte une PF sans article_matiere mais refuse explicitement article_matiere=null", () => {
    expect(createArticleSchema.safeParse({ body: validCases[0].body }).success).toBe(true);
    expect(createArticleSchema.safeParse({
      body: { ...validCases[0].body, article_matiere: null },
    }).success).toBe(false);
  });

  it("interdit les détails matière hors matière, y compris lors d'une mise à jour explicitement catégorisée", () => {
    expect(createArticleSchema.safeParse({
      body: { ...validCases[3].body, article_matiere: {} },
    }).success).toBe(false);
    expect(updateArticleSchema.safeParse({
      body: { expected_row_version: 1, article_category: "achat", article_matiere: {} },
    }).success).toBe(false);
  });

  it("autorise un PATCH matière sans article_matiere afin de préserver les détails existants", () => {
    expect(updateArticleSchema.safeParse({
      body: { expected_row_version: 1, designation: "Rond acier corrigé" },
    }).success).toBe(true);
  });

  it("préserve les détails matière lorsque le PATCH ne fournit pas article_matiere", async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("information_schema.columns")) return { rows: [{ present: true }] };
        return { rows: [] };
      },
    } as Parameters<typeof syncArticleSubtypeDetails>[0];

    await syncArticleSubtypeDetails(client, {
      article_id: PT_ID,
      category: "matiere",
      family_code: "RO",
      piece_technique_id: null,
    });

    expect(queries.some((sql) => sql.includes("DELETE FROM public.articles_matiere"))).toBe(false);
    const materialUpsert = queries.find((sql) =>
      /INSERT INTO public\.articles_matiere\s*\(/.test(sql)
    );
    const materialUpsertText = materialUpsert ?? "";
    expect(materialUpsertText).toContain("SET family_code = EXCLUDED.family_code");
    expect(materialUpsertText).not.toContain("longueur_mm = EXCLUDED.longueur_mm");
  });
});
