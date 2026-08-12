import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("../config/database", () => ({
  default: { query: queryMock },
}));

import { repoListArticles } from "../module/stock/repository/stock.repository";

function normalized(sql: unknown): string {
  return String(sql).replace(/\s+/g, " ").trim();
}

describe("BUG-CERP-0015 - filtre GET /stock/articles", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
  });

  it("applique le predicat canonique complet sans categorie secondaire", async () => {
    await repoListArticles({ commande_client_selectable: true });

    expect(queryMock).toHaveBeenCalledTimes(2);
    for (const call of queryMock.mock.calls) {
      const sql = normalized(call[0]);
      expect(sql).toContain("a.is_active = TRUE");
      expect(sql).toContain("a.stock_managed = TRUE");
      expect(sql).toContain("a.article_category IN ('fabrique', 'PIECE_TECHNIQUE')");
      expect(sql).toContain("a.piece_technique_id IS NOT NULL");
      expect(sql).not.toContain("aclf.category_code");
    }
  });

  it("inverse exactement le meme predicat pour selectable=false", async () => {
    await repoListArticles({ commande_client_selectable: false });

    const countSql = normalized(queryMock.mock.calls[0]?.[0]);
    expect(countSql).toContain("IS NOT TRUE");
    expect(countSql).toContain("a.article_category IN ('fabrique', 'PIECE_TECHNIQUE')");
  });

  it("filtre les articles PF par code client métier", async () => {
    await repoListArticles({ client_code: "CLI-0042" });

    expect(normalized(queryMock.mock.calls[0]?.[0])).toContain(
      "LOWER(TRIM(COALESCE(pt.code_client, ''))) = LOWER(TRIM($1))"
    );
    expect(queryMock.mock.calls[0]?.[1]).toEqual(["CLI-0042"]);
    expect(normalized(queryMock.mock.calls[1]?.[0])).toContain("latest_version.plan_reference AS piece_plan_reference");
  });
});
