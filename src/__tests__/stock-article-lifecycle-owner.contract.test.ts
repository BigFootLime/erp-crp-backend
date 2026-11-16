import { describe, expect, it } from "vitest";
import * as facade from "../module/stock/repository/stock.repository";
import * as lifecycle from "../module/stock/repository/stock-article-lifecycle.repository";

describe("stock article lifecycle owner", () => {
  it("keeps creation, subtype, unit, lifecycle and PDF snapshot APIs on one owner", () => {
    expect(facade.repoCreateArticleTx).toBe(lifecycle.repoCreateArticleTx);
    expect(facade.repoCreateArticle).toBe(lifecycle.repoCreateArticle);
    expect(facade.repoUpdateArticle).toBe(lifecycle.repoUpdateArticle);
    expect(facade.syncArticleSubtypeDetails).toBe(lifecycle.syncArticleSubtypeDetails);
    expect(facade.assertCanonicalArticleUnit).toBe(lifecycle.assertCanonicalArticleUnit);
    expect(facade.queueStockArticleCreationSnapshotTx).toBe(lifecycle.queueStockArticleCreationSnapshotTx);
    expect(facade.repoValidateArticle).toBe(lifecycle.repoValidateArticle);
    expect(facade.repoArchiveArticle).toBe(lifecycle.repoArchiveArticle);
    expect(facade.repoReactivateArticle).toBe(lifecycle.repoReactivateArticle);
  });
});
