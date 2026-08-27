import { describe, expect, it } from "vitest";

import { createArticleSchema, updateArticleSchema } from "./stock.validators";

describe("stock article sale-price validation", () => {
  const create = (salePrice: number | null) => createArticleSchema.safeParse({
    body: {
      designation: "Article test",
      article_category: "achat",
      family_code: "ACH",
      sale_price_reference: salePrice,
    },
  });
  const update = (salePrice: number | null) => updateArticleSchema.safeParse({
    body: { expected_row_version: 1, sale_price_reference: salePrice },
  });

  it("distinguishes an absent price from a positive reference price", () => {
    expect(create(null).success).toBe(true);
    expect(create(12.3456).success).toBe(true);
    expect(create(0).success).toBe(false);
    expect(create(-1).success).toBe(false);
  });

  it("allows clearing or replacing a reference on update", () => {
    expect(update(null).success).toBe(true);
    expect(update(22).success).toBe(true);
    expect(update(0).success).toBe(false);
  });
});
