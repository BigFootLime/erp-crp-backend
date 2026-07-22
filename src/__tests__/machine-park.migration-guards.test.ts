import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const patch = readFileSync(resolve(root, "db/patches/20260722_machine_park_165.sql"), "utf8");
const preflight = readFileSync(resolve(root, "db/patches/support/20260722_machine_park_165.preflight.sql"), "utf8");
const verify = readFileSync(resolve(root, "db/patches/support/20260722_machine_park_165.verify.sql"), "utf8");
const rollback = readFileSync(resolve(root, "db/patches/support/20260722_machine_park_165.rollback.sql"), "utf8");
const intelligenceRepo = readFileSync(resolve(root, "src/module/production/repository/machine-intelligence.repository.ts"), "utf8");

describe("#165 migration safety guards", () => {
  it("uses the central MCH allocator and an immutable machine-code trigger", () => {
    expect(patch).toMatch(/\bMCH\b/);
    expect(patch).toContain("fn_prevent_machine_code_mutation");
    expect(patch).toContain("Machine code is immutable");
    expect(patch).not.toMatch(/MAX\s*\(\s*code\s*\)/i);
  });

  it("separates unknown rate from zero and records explicit provenance", () => {
    expect(patch).toContain("ALTER COLUMN hourly_rate DROP DEFAULT");
    expect(patch).toContain("ALTER COLUMN hourly_rate DROP NOT NULL");
    expect(patch).toContain("hourly_rate_source");
    expect(patch).toContain("hourly_rate_effective_at");
    expect(patch).toContain("hourly_rate_is_override");
    expect(patch).toContain("SET hourly_rate_source = 'UNKNOWN'");
  });

  it("reuses canonical planning events for temporal unavailability", () => {
    expect(patch).toContain("planning_event_id uuid NOT NULL");
    expect(patch).toContain("REFERENCES public.planning_events(id)");
    expect(patch).toContain("UNIQUE (planning_event_id)");
  });

  it("keeps maintenance history append-only and rollback traceability-safe", () => {
    expect(patch).toContain("production_machine_maintenance_events");
    expect(rollback).toContain("rollback refused: business rows exist");
    expect(rollback).toContain("intentionally preserved");
  });

  it("provides preflight and verification without production writes", () => {
    expect(preflight).toContain("zero_rates_to_review");
    expect(verify).toContain("rogue code scope rejected");
    expect(verify).toContain("has_unavailability");
  });

  it("never exposes document storage paths through the machine intelligence repository", () => {
    expect(intelligenceRepo).not.toContain("storage_path");
    expect(intelligenceRepo).toContain("removed_at IS NULL");
  });
});
