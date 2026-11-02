import { describe, expect, it, vi } from "vitest";

vi.mock("./industrial-policy.repository", () => ({
  readIndustrialPolicy: vi.fn().mockResolvedValue({ client_id: "042", version: 1 }),
}));

import { getIndustrialSettings, updateIndustrialSettings } from "./industrial-settings.repository";
import { industrialSettingsSchema } from "../validators/industrial-plan.validators";

const articleId = "00000000-0000-4000-8000-000000000042";
const row = { article_id: articleId, code: "VS-42", designation: "Pièce Vision", family: "VS", lead_days: 2, unit_cost_eur: 1, yield_percent: null, lot_size: 1 };
const empty = { rows: [], rowCount: 0 };

function dbForSettings() {
  const query = vi.fn()
    // current GET
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    .mockResolvedValueOnce(empty)
    // article rule write and audit event
    .mockResolvedValueOnce(empty)
    .mockResolvedValueOnce(empty)
    // returned GET
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    .mockResolvedValueOnce(empty);
  return { query };
}

describe("industrial settings yield qualification", () => {
  it("keeps an omitted yield absent instead of defaulting it to an approved 100%", () => {
    const parsed = industrialSettingsSchema.parse({
      client_id: "042",
      articles: [{ article_id: articleId, family: "VS", lead_days: 2, unit_cost_eur: 1, lot_size: 1 }],
      contracts: [],
    });
    expect(parsed.articles[0].yield_percent).toBeUndefined();
    expect(() => industrialSettingsSchema.parse({
      client_id: "042", articles: [{ article_id: articleId, family: "VS", lead_days: 2, unit_cost_eur: 1, lot_size: 1, yield_percent: 0 }], contracts: [],
    })).toThrow();
  });

  it("does not update the qualification timestamp when no yield was supplied", async () => {
    const db = dbForSettings();
    const body = industrialSettingsSchema.parse({
      client_id: "042",
      articles: [{ article_id: articleId, family: "VS", lead_days: 2, unit_cost_eur: 1, lot_size: 1 }],
      contracts: [],
    });
    await updateIndustrialSettings(db as never, 7, body);
    const write = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.industrial_article_rules"));
    expect(write?.[0]).toContain("CASE WHEN $5::numeric IS NULL THEN industrial_article_rules.yield_qualified_at");
    expect(write?.[1]?.[4]).toBeUndefined();
  });

  it("records an explicit 100% yield as qualified", async () => {
    const db = dbForSettings();
    const body = industrialSettingsSchema.parse({
      client_id: "042",
      articles: [{ article_id: articleId, family: "VS", lead_days: 2, unit_cost_eur: 1, lot_size: 1, yield_percent: 100 }],
      contracts: [],
    });
    await updateIndustrialSettings(db as never, 7, body);
    const write = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.industrial_article_rules"));
    expect(write?.[0]).toContain("yield_qualified_at");
    expect(write?.[1]?.[4]).toBe(100);
  });

  it("exposes an unqualified MAKE yield as unknown in settings", async () => {
    const db = { query: vi.fn().mockResolvedValueOnce({ rows: [row], rowCount: 1 }).mockResolvedValueOnce(empty) };
    await expect(getIndustrialSettings(db as never, "042")).resolves.toMatchObject({ articles: [{ yield_percent: null }] });
    expect(db.query.mock.calls[0][0]).toContain("r.yield_qualified_at IS NULL");
  });
});
