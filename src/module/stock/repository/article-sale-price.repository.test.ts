import { describe, expect, it, vi } from "vitest";

import { applyOrderLineSalePriceTx } from "./article-sale-price.repository";

const articleId = "11111111-1111-4111-8111-111111111111";
const historyId = "22222222-2222-4222-8222-222222222222";

describe("article sale price reference", () => {
  it("sets the first positive customer-order price and returns an auditable snapshot", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FOR UPDATE")) {
        return { rows: [{ sale_price_reference: null, sale_price_currency: "EUR", sale_price_source: null }] };
      }
      if (sql.includes("INSERT INTO public.article_sale_price_history")) return { rows: [{ id: historyId }] };
      if (sql.includes("UPDATE public.articles")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await applyOrderLineSalePriceTx({ query } as never, {
      article_id: articleId,
      proposed_price: 42.5,
      source: "CUSTOMER_ORDER",
      source_entity_type: "COMMANDE",
      source_entity_id: "123",
      actor_user_id: 7,
      line_index: 0,
    });

    expect(result).toEqual({
      reference_price: 42.5,
      reference_source: "CUSTOMER_ORDER",
      decision: "SET",
      history_id: historyId,
    });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("requires an explicit choice when the order price differs", async () => {
    const query = vi.fn(async () => ({
      rows: [{ sale_price_reference: 40, sale_price_currency: "EUR", sale_price_source: "ARTICLE_SHEET" }],
    }));

    await expect(
      applyOrderLineSalePriceTx({ query } as never, {
        article_id: articleId,
        proposed_price: 45,
        source: "CUSTOMER_ORDER",
        source_entity_type: "COMMANDE",
        source_entity_id: "123",
        actor_user_id: 7,
        line_index: 2,
      })
    ).rejects.toMatchObject({
      status: 409,
      code: "ARTICLE_SALE_PRICE_DECISION_REQUIRED",
      details: { line_index: 2, current_reference_price: 40, proposed_price: 45 },
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("keeps the article reference while retaining the line-specific price", async () => {
    const query = vi.fn(async () => ({
      rows: [{ sale_price_reference: 40, sale_price_currency: "EUR", sale_price_source: "ARTICLE_SHEET" }],
    }));

    const result = await applyOrderLineSalePriceTx({ query } as never, {
      article_id: articleId,
      proposed_price: 45,
      decision: "KEEP",
      source: "CUSTOMER_ORDER",
      source_entity_type: "COMMANDE",
      source_entity_id: "123",
      actor_user_id: 7,
      line_index: 0,
    });

    expect(result).toEqual({
      reference_price: 40,
      reference_source: "ARTICLE_SHEET",
      decision: "KEEP",
      history_id: null,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
