import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("isolated deterministic seed contract", () => {
  it("resets access reviews only after the loopback cerp_test guard", () => {
    const source = readFileSync(path.resolve("scripts/e2e/seed-isolated.js"), "utf8");
    const guard = source.indexOf("assertIsolated();");
    const capabilityCheck = source.indexOf("to_regclass('public.app_access_review_items')");
    const guardedReset = source.indexOf("if (accessReviewTables.rows[0]?.items && accessReviewTables.rows[0]?.reviews)");
    const deleteItems = source.indexOf("DELETE FROM public.app_access_review_items");
    const deleteReviews = source.indexOf("DELETE FROM public.app_access_reviews");

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(capabilityCheck).toBeGreaterThan(guard);
    expect(guardedReset).toBeGreaterThan(capabilityCheck);
    expect(deleteItems).toBeGreaterThan(guardedReset);
    expect(deleteReviews).toBeGreaterThan(deleteItems);
  });
});
