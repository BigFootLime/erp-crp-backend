import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => fs.readFileSync(path.resolve(process.cwd(), name), "utf8");
const patch = read("db/patches/20260814_planning_execution_intelligence_0021.sql");
const preflight = read("db/patches/support/20260814_planning_execution_intelligence_0021.preflight.sql");
const verify = read("db/patches/support/20260814_planning_execution_intelligence_0021.verify.sql");
const rollback = read("db/patches/support/20260814_planning_execution_intelligence_0021.rollback.sql");
const releaseGate = read("scripts/migrations/release-gate.js");

describe("SOL-21 planning execution migration guards", () => {
  it("adds only audited user preferences and validates color values server-side", () => {
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.planning_user_preferences");
    expect(patch).toContain("fn_planning_color_map_is_valid");
    expect(patch).toContain("horizon_weeks BETWEEN 1 AND 13");
    expect(patch).toContain("REFERENCES public.users(id)");
    expect(patch).toContain("'OFFLINE_STATION'");
    expect(patch).toContain("VALIDATE CONSTRAINT production_pointages_source_sol21_chk");
    expect(patch).toMatch(/GRANT SELECT ON public\.machines TO cerp_app/);
    expect(patch).not.toMatch(/INSERT\s+INTO\s+public\.planning_user_preferences/i);
  });

  it("fails preflight on missing sources or invalid timezones and verifies the trigger", () => {
    expect(preflight).toContain("production_quantity_declarations");
    expect(preflight).toContain("pg_timezone_names");
    expect(preflight).toContain("production calendar(s) use an unknown timezone");
    expect(verify).toContain("planning_user_preferences_set_updated_at");
    expect(verify).toContain("does not fail closed");
    expect(verify).toContain("v_station_machine_occupancy");
    expect(verify).toContain("SET LOCAL ROLE cerp_app");
    expect(verify).toContain("offline pointage provenance is not accepted");
  });

  it("guards destructive rollback and is exercised by the isolated release gate", () => {
    expect(rollback).toContain("cerp.sol21_preferences_exported");
    expect(rollback).toContain("rollback refused");
    expect(releaseGate).toContain('const PLANNING_EXECUTION_PATCH = "20260814_planning_execution_intelligence_0021.sql"');
    expect(releaseGate).toContain("planning_execution_removed");
  });
});
