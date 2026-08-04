import { describe, expect, it, vi } from "vitest";

import { resolveUnitIdForArticle as resolveDeliveryUnit } from "../module/livraisons/repository/livraisons.repository";
import { resolveUnitIdForArticle as resolveProductionUnit } from "../module/production/repository/production-receipts.repository";
import { resolveUnitIdForArticle as resolveQualityUnit } from "../module/qualite/repository/qualite.repository";
import { resolveUnitIdForArticle as resolveStockUnit } from "../module/stock/repository/stock.repository";

const ARTICLE_ID = "11111111-1111-4111-8111-111111111111";
const UNIT_ID = "22222222-2222-4222-8222-222222222222";

type Resolution = string | { unit_id: string; unit_code: string };
type Resolver = (db: never, articleId: string, preferred: null) => Promise<Resolution>;

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
});
