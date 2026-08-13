import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("SOL-20 migration guards", () => {
  const migration = read("db/patches/20260813_sol20_tooling_technical_ged.sql");
  const preflight = read("db/patches/support/20260813_sol20_tooling_technical_ged.preflight.sql");
  const verify = read("db/patches/support/20260813_sol20_tooling_technical_ged.verify.sql");
  const rollback = read("db/patches/support/20260813_sol20_tooling_technical_ged.rollback.sql");

  it("keeps lifecycle history append-only and idempotent per actor", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.outillage_lifecycle_events");
    expect(migration).toContain("UNIQUE (actor_user_id, idempotency_key)");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON public.outillage_lifecycle_events");
  });

  it("preflights dependencies, verifies integrity and refuses a lossy rollback", () => {
    expect(preflight).toContain("SOL20_PREFLIGHT_MISSING_RELATIONS");
    expect(preflight).toContain("backup_required_before_apply");
    expect(verify).toContain("invalid_allocation_quantities");
    expect(verify).toContain("duplicate_idempotency_keys");
    expect(rollback).toContain("SOL20_ROLLBACK_REFUSED");
  });

  it("never backfills legacy documents with a fabricated clean scan", () => {
    expect(migration).not.toMatch(/UPDATE\s+public\.ged_(document_versions|upload_sessions)/i);
    expect(migration).toContain("fn_ged_validate_canonical_entity_link_20");
  });
});
