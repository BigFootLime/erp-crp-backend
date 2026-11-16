import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), requirements: vi.fn() }));
vi.mock("../../../config/database", () => ({ default: { query: mocks.query } }));
vi.mock("./material-bar-count-read-model.repository", () => ({ readMaterialBarCountRequirementsTx: mocks.requirements }));
import { repoGetStockAnalytics, repoListBalances, repoListConsolidatedInventory, repoListMovements } from "./stock-reporting.repository";
import { listAnalyticsQuerySchema, listBalancesQuerySchema, listConsolidatedInventoryQuerySchema, listMovementsQuerySchema } from "../validators/stock.validators";

describe("stock reporting owner", () => {
  beforeEach(() => { mocks.query.mockReset(); mocks.requirements.mockReset(); });

  it("keeps movement filters bound in count/data order and preserves requested pagination and sort", async () => {
    const item = { id: "movement-1", movement_no: "MOV-1" };
    mocks.query.mockResolvedValueOnce({ rows: [{ total: 19 }] }).mockResolvedValueOnce({ rows: [item] });
    const filters = listMovementsQuerySchema.parse({ q: "lot%", movement_type: "IN", status: "POSTED", page: 3, pageSize: 10, sortBy: "posted_at", sortDir: "asc" });
    await expect(repoListMovements(filters)).resolves.toEqual({ items: [item], total: 19 });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(["%lot%%", "IN", "POSTED"]);
    expect(mocks.query.mock.calls[1]?.[1]).toEqual(["%lot%%", "IN", "POSTED", 10, 20]);
    expect(mocks.query.mock.calls[1]?.[0]).toContain("ORDER BY m.posted_at ASC");
    expect(mocks.query.mock.calls[1]?.[0]).toContain("LIMIT $4");
  });

  it("keeps bar-count requirements attached to the correct article/batch without changing balance rows", async () => {
    const rows = [{ article_id: "article-1", stock_batch_id: "batch-1", qty_available: 7 }, { article_id: "article-2", stock_batch_id: null, qty_available: 3 }];
    mocks.query.mockResolvedValueOnce({ rows: [{ total: 2 }] }).mockResolvedValueOnce({ rows });
    mocks.requirements.mockResolvedValue(new Map([["article-1:batch-1", { material_bar_count_required: true }]]));
    await expect(repoListBalances(listBalancesQuerySchema.parse({ only_available: true, physical_state: "present" })))
      .resolves.toEqual({ items: [{ ...rows[0], material_bars_required: true }, { ...rows[1], material_bars_required: false }], total: 2 });
    expect(mocks.query.mock.calls[1]?.[0]).toContain("b.qty_available > 0");
    expect(mocks.query.mock.calls[1]?.[0]).toContain("b.qty_total > 0");
    expect(mocks.requirements).toHaveBeenCalledWith(expect.anything(), rows);
  });

  it("keeps OLD material display projection separate from NEW stock and removes internal projection columns", async () => {
    const material = { material_article_category: "matiere", material_designation: "Steel", material_profile_code: "RO", material_nuance_code: "42", material_etat_code: "REC", material_sous_etat_code: null, material_longueur_mm: 3000, material_largeur_mm: null, material_hauteur_mm: null, material_epaisseur_mm: null, material_diametre_mm: 10 };
    mocks.query.mockResolvedValueOnce({ rows: [{ total: 2 }] }).mockResolvedValueOnce({ rows: [{ article_id: "old", scope: "OLD", ...material }, { article_id: "new", scope: "NEW", ...material }] });
    const result = await repoListConsolidatedInventory(listConsolidatedInventoryQuerySchema.parse({ scope: "OLD", page: 2, pageSize: 25 }));
    expect(result.total).toBe(2);
    expect(result.items[0]).toEqual({ article_id: "old", scope: "OLD", old_material_definition: "RO-42-REC-3000-10" });
    expect(result.items[1]).toEqual({ article_id: "new", scope: "NEW", old_material_definition: null });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(["OLD"]);
    expect(mocks.query.mock.calls[1]?.[1]).toEqual(["OLD", 25, 25]);
    expect(mocks.query.mock.calls[1]?.[0]).toContain("btrim(piece_client.client_code)");
    expect(mocks.query.mock.calls[1]?.[0]).toContain("btrim(piece.client_id)");
  });

  it("preserves authoritative analytics scope and empty aggregate defaults", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const result = await repoGetStockAnalytics(listAnalyticsQuerySchema.parse({ from: "2026-11-01T00:00:00Z", to: "2026-11-14T00:00:00Z" }));
    expect(result.authoritative).toBe(true);
    expect(result.scope).toEqual({ magasin_id: null, from: "2026-11-01T00:00:00Z", to: "2026-11-14T00:00:00Z" });
    expect(result.kpis).toMatchObject({ articles_count: 0, qty_on_hand: 0, qty_available: 0, active_inventory_count: 0 });
    expect(result.series).toEqual({ net_by_date: [], top_articles: [] });
    expect(mocks.query).toHaveBeenCalledTimes(6);
    expect(mocks.query.mock.calls.some(([, params]) => Array.isArray(params) && params.includes("2026-11-01T00:00:00Z"))).toBe(true);
  });
});
