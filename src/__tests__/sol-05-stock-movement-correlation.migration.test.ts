import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/repo-paths";

const migration = readFileSync(
  resolve(repoRoot, "db/patches/20260810_stock_movement_event_correlation.sql"),
  "utf8"
);
const support = ["preflight", "verify", "rollback"].map((kind) =>
  readFileSync(
    resolve(repoRoot, `db/patches/support/20260810_stock_movement_event_correlation.${kind}.sql`),
    "utf8"
  )
);

describe("SOL-05 stock movement event correlation migration", () => {
  it("is transactional and additive", () => {
    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("COMMIT;");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS correlation_id uuid NULL");
    expect(migration).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
  });

  it("provides preflight, post-validation and a data-preserving rollback guard", () => {
    expect(support[0]).toContain("movement_references_are_valid");
    expect(support[1]).toContain("has_correlation_id");
    expect(support[2]).toContain("Correlated stock movement audit evidence exists");
  });
});
