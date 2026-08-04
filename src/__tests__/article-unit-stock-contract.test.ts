import { describe, expect, it } from "vitest";

import {
  assertCanonicalArticleUnit,
  resolveUnitIdForArticle,
} from "../module/stock/repository/stock.repository";

const ARTICLE_ID = "11111111-1111-4111-8111-111111111111";
const MILLIMETRE_UNIT_ID = "22222222-2222-4222-8222-222222222222";

describe("#475 article/stock unit contract", () => {
  it("accepts the canonical mm article unit and resolves it for a nominal stock movement", async () => {
    const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        if (sql.includes("SELECT code FROM public.units")) return { rows: [{ code: "mm" }] };
        if (sql.includes("SELECT unite FROM public.articles")) return { rows: [{ unite: "mm" }] };
        if (sql.includes("SELECT id::text AS id FROM public.units")) return { rows: [{ id: MILLIMETRE_UNIT_ID }] };
        return { rows: [] };
      },
    };

    await expect(assertCanonicalArticleUnit(client, "mm")).resolves.toBeUndefined();
    await expect(resolveUnitIdForArticle(client, ARTICLE_ID, null)).resolves.toBe(MILLIMETRE_UNIT_ID);
    expect(queries.some(({ values }) => values?.[0] === "mm")).toBe(true);
  });

  it("rejects an invalid article unit before the article is persisted", async () => {
    const client = { query: async () => ({ rows: [] }) };

    await expect(assertCanonicalArticleUnit(client, "banane")).rejects.toMatchObject({
      status: 400,
      code: "INVALID_ARTICLE_UNIT",
      message: expect.stringContaining("banane"),
    });
  });
});
