import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("SOL-06 canonical base-unit drift repair", () => {
  const read = (name: string) => fs.readFileSync(path.join(process.cwd(), "db", "patches", name), "utf8");

  it("restores only u, records provenance and requires backup restoration for rollback", () => {
    const patch = read("20260811_base_unit_drift_repair.sql");
    const preflight = read("support/20260811_base_unit_drift_repair.preflight.sql");
    const verify = read("support/20260811_base_unit_drift_repair.verify.sql");
    const rollback = read("support/20260811_base_unit_drift_repair.rollback.sql");

    expect(patch).toMatch(/VALUES \('u', 'Unite'\)/);
    expect(patch).toMatch(/cerp_patch_20260811_base_unit_repair/);
    expect(patch).toMatch(/duplicate case-insensitive u codes/);
    expect(preflight).toMatch(/20260223_seed_currencies_units\.sql/);
    expect(verify).toMatch(/one_canonical_base_unit/);
    expect(verify).toMatch(/provenance_matches_unit/);
    expect(rollback).toMatch(/requires restoration of the validated pre-migration backup/);
  });
});
