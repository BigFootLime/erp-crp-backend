import { describe, expect, it, vi } from "vitest";

import { resolveUnitIdForArticle as resolveDeliveryUnit } from "../module/livraisons/repository/livraisons.repository";
import { resolveUnitIdForArticle as resolveProductionUnit } from "../module/production/repository/production-receipts.repository";
import { resolveUnitIdForArticle as resolveQualityUnit } from "../module/qualite/repository/qualite.repository";
import { resolveUnitIdForArticle as resolveStockUnit } from "../module/stock/repository/stock.repository";

const ARTICLE_ID = "11111111-1111-4111-8111-111111111111";
const UNIT_ID = "22222222-2222-4222-8222-222222222222";

type Resolution = string | { unit_id: string; unit_code: string };
type Resolver = (db: never, articleId: string, preferred: string | null | undefined) => Promise<Resolution>;

const resolvers: Array<[string, Resolver, number, string]> = [
  ["stock", resolveStockUnit as Resolver, 400, "UNKNOWN_UNIT"],
  ["production", resolveProductionUnit as Resolver, 422, "UNIT_NOT_FOUND"],
  ["livraison", resolveDeliveryUnit as Resolver, 400, "UNKNOWN_UNIT"],
  ["qualité", resolveQualityUnit as Resolver, 400, "UNKNOWN_UNIT"],
];

function databaseWithHistoricalArticle(unit: string) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM public.articles")) return { rows: [{ unite: unit }], rowCount: 1 };
    if (sql.includes("FROM public.units")) {
      return values?.[0] === "banane"
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: UNIT_ID }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { db: { query } as never, query };
}

function databaseForUnitResolution(options: {
  articleUnit?: string | null;
  unitCodes?: readonly string[];
}) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM public.articles")) {
      return options.articleUnit === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ unite: options.articleUnit }], rowCount: 1 };
    }
    if (sql.includes("FROM public.units")) {
      return options.unitCodes?.includes(String(values?.[0]))
        ? { rows: [{ id: UNIT_ID }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { db: { query } as never, query };
}

function normalizedSql(query: ReturnType<typeof vi.fn>, callIndex: number) {
  return String(query.mock.calls[callIndex]?.[0]).replace(/\s+/g, " ").trim();
}

describe("#475 historical unit adapters across stock-producing modules", () => {
  it.each(resolvers)("canonicalizes PCE/PC/MM in %s before resolving public.units", async (_name, resolver) => {
    for (const [historical, canonical] of [["PCE", "u"], ["PC", "u"], ["MM", "mm"]] as const) {
      const { db, query } = databaseWithHistoricalArticle(historical);
      const resolution = await resolver(db, ARTICLE_ID, null);

      expect(resolution).toEqual(
        _name === "production" ? { unit_id: UNIT_ID, unit_code: canonical } : UNIT_ID
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("FROM public.units"),
        [canonical]
      );
    }
  });

  it.each(resolvers)("rejects an unresolved historical unit in %s", async (_name, resolver, status, code) => {
    const { db } = databaseWithHistoricalArticle("BANANE");
    await expect(resolver(db, ARTICLE_ID, null)).rejects.toMatchObject({ status, code });
  });

  it.each(resolvers)("uses the supplied transaction client and skips the article lookup for a preferred canonical alias in %s", async (_name, resolver) => {
    const { db, query } = databaseForUnitResolution({ unitCodes: ["u"] });

    await expect(resolver(db, ARTICLE_ID, " PCE ")).resolves.toEqual(
      _name === "production" ? { unit_id: UNIT_ID, unit_code: "u" } : UNIT_ID
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM public.units"), ["u"]);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("FROM public.articles"))).toBe(false);
  });

  it.each(resolvers)("keeps a numeric canonical unit code and resolves it through the supplied client in %s", async (_name, resolver) => {
    const { db, query } = databaseForUnitResolution({ unitCodes: ["1"] });

    await expect(resolver(db, ARTICLE_ID, " 1 ")).resolves.toEqual(
      _name === "production" ? { unit_id: UNIT_ID, unit_code: "1" } : UNIT_ID
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM public.units"), ["1"]);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["whitespace", "   "],
  ] as const)("treats a %s preferred unit as absent and falls back to the article unit", async (_state, preferred) => {
    for (const [name, resolver] of resolvers) {
      const { db, query } = databaseForUnitResolution({ articleUnit: "MM", unitCodes: ["mm"] });

      await expect(resolver(db, ARTICLE_ID, preferred)).resolves.toEqual(
        name === "production" ? { unit_id: UNIT_ID, unit_code: "mm" } : UNIT_ID
      );
      expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("FROM public.articles"), [ARTICLE_ID]);
      expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("FROM public.units"), ["mm"]);
      expect(normalizedSql(query, 0).includes("LIMIT 1")).toBe(name === "production");
    }
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", "   "],
  ] as const)("preserves the %s article-unit policy in every caller", async (_state, articleUnit) => {
    for (const [name, resolver] of resolvers) {
      const { db, query } = databaseForUnitResolution({ articleUnit, unitCodes: ["u"] });

      if (name === "production") {
        await expect(resolver(db, ARTICLE_ID, null)).rejects.toMatchObject({
          status: 422,
          code: "UNIT_REQUIRED",
          message: "Veuillez renseigner l'unite pour la mise en stock",
        });
        expect(query).toHaveBeenCalledTimes(1);
        expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM public.articles"), [ARTICLE_ID]);
      } else {
        await expect(resolver(db, ARTICLE_ID, null)).resolves.toBe(UNIT_ID);
        expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("FROM public.articles"), [ARTICLE_ID]);
        expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("FROM public.units"), ["u"]);
      }
      expect(normalizedSql(query, 0).includes("LIMIT 1")).toBe(name === "production");

    }
  });

  it.each(resolvers)("rejects an unknown preferred unit without consulting the article in %s", async (_name, resolver, status, code) => {
    const { db, query } = databaseForUnitResolution({ articleUnit: "mm", unitCodes: [] });
    const expected = _name === "production"
      ? { status, code, message: "Unite inconnue" }
      : {
          status,
          code,
          message: `Unknown unit code: ${_name === "stock" ? "BANANE" : "banane"}`,
        };

    await expect(resolver(db, ARTICLE_ID, " BANANE ")).rejects.toMatchObject(expected);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM public.units"), ["banane"]);
  });

  it.each(resolvers)("propagates a supplied client query failure without falling back to another database client in %s", async (_name, resolver) => {
    const failure = new Error("injected query failure");
    const query = vi.fn().mockRejectedValueOnce(failure);
    const injectedClient = Object.freeze({ query });

    await expect(resolver(injectedClient as never, ARTICLE_ID, null)).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM public.articles"), [ARTICLE_ID]);
  });
});
