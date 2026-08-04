import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertCanonicalArticleUnit,
  repoCreateArticleTx,
  resolveUnitIdForArticle,
} from "../module/stock/repository/stock.repository";
import { canonicalizeStockUnitCode } from "../shared/stock-unit";
import { createArticleSchema } from "../module/stock/validators/stock.validators";

const ARTICLE_ID = "11111111-1111-4111-8111-111111111111";
const MILLIMETRE_UNIT_ID = "22222222-2222-4222-8222-222222222222";

describe("#475 article/stock unit contract", () => {
  it.each([
    ["PCE", "u"], ["pcs", "u"], ["PC", "u"], [" unite ", "u"], ["U", "u"], ["MM", "mm"], ["Kg", "kg"], ["M", "m"],
  ])("canonicalizes the historical stock unit %s as %s", (input, expected) => {
    expect(canonicalizeStockUnitCode(input)).toBe(expected);
  });

  it("creates a real article with canonical mm then resolves its unit for a stock movement", async () => {
    const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
    let storedUnit: string | null = null;
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        if (sql.includes("FROM public.units")) return { rows: [{ id: MILLIMETRE_UNIT_ID }] };
        if (sql.includes("fn_next_issued_code_value")) return { rows: [{ v: "42" }] };
        if (sql.includes("INSERT INTO public.articles (")) {
          storedUnit = (values?.[9] as string | null) ?? null;
          return { rows: [{ id: ARTICLE_ID }] };
        }
        if (sql.includes("SELECT unite FROM public.articles")) return { rows: [{ unite: storedUnit }] };
        return { rows: [] };
      },
    };

    const body = createArticleSchema.parse({ body: {
      designation: "Tôle 2 mm",
      article_category: "achat",
      article_categories: ["achat_revente"],
      family_code: "ACH",
      unite: "MM",
    } }).body;
    const audit = {
      user_id: 1, ip: null, user_agent: null, device_type: null, os: null,
      browser: null, path: "/api/v1/stock/articles", page_key: "stock", client_session_id: null,
    };

    const created = await repoCreateArticleTx(client as never, body, audit);
    expect(created.id).toBe(ARTICLE_ID);
    expect(storedUnit).toBe("mm");
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

  it("keeps preflight, verification and exact-row rollback guards coherent", () => {
    const patch = readFileSync(resolve("db/patches/20260804_article_unit_stock_contract.sql"), "utf8");
    const preflight = readFileSync(resolve("db/patches/support/20260804_article_unit_stock_contract.preflight.sql"), "utf8");
    const verify = readFileSync(resolve("db/patches/support/20260804_article_unit_stock_contract.verify.sql"), "utf8");
    const rollback = readFileSync(resolve("db/patches/support/20260804_article_unit_stock_contract.rollback.sql"), "utf8");

    expect(patch).toMatch(/\('mm'::text, 'Millimètre'::text\)/);
    expect(patch).toMatch(/\('m'::text,\s+'Mètre'::text\)/);
    expect(patch).toMatch(/\('kg'::text, 'Kilogramme'::text\)/);
    expect(patch).toContain("unit_id text NOT NULL");
    expect(patch).not.toMatch(/UPDATE\s+public\.articles/i);

    for (const guard of [preflight, verify]) {
      expect(guard).toContain("'pc','pce','pces','pcs'");
      expect(guard).toContain("'unit','units','unite','unites','unité','unités'");
      expect(guard).toContain("\\quit 3");
      expect(guard).toContain("has_unresolved");
    }

    expect(rollback).toContain("current_database() = 'cerp_prod'");
    expect(rollback).toContain("id::text = seeded.unit_id");
    expect(rollback).not.toMatch(/DELETE\s+FROM\s+public\.articles/i);
  });
});
