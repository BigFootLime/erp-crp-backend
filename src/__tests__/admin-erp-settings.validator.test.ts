import { describe, expect, it } from "vitest";

import {
  adminErpSettingKeySchema,
  adminUpsertErpSettingSchema,
} from "../module/admin/validators/admin.validators";

describe("administrative ERP setting validation", () => {
  it("allows only the shipping location setting", () => {
    expect(adminErpSettingKeySchema.safeParse({
      params: { key: "stock.default_shipping_location" },
    }).success).toBe(true);
    expect(adminErpSettingKeySchema.safeParse({
      params: { key: "stock.valuation_method" },
    }).success).toBe(false);
  });

  it("normalizes positive stock identifiers and rejects partial values", () => {
    const parsed = adminUpsertErpSettingSchema.parse({
      params: { key: "stock.default_shipping_location" },
      body: { value_json: { magasin_id: 12, emplacement_id: "34" }, value_text: null },
    });
    expect(parsed.body.value_json).toEqual({ magasin_id: "12", emplacement_id: "34" });
    expect(adminUpsertErpSettingSchema.safeParse({
      params: { key: "stock.default_shipping_location" },
      body: { value_json: { magasin_id: "12" } },
    }).success).toBe(false);
  });
});
