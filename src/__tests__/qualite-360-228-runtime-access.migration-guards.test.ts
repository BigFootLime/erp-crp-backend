import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const patch = readFileSync(
  resolve(root, "db/patches/20260725_qualite_360_228_runtime_access.sql"),
  "utf8"
);
const preflight = readFileSync(
  resolve(root, "db/patches/support/20260725_qualite_360_228_runtime_access.preflight.sql"),
  "utf8"
);
const verify = readFileSync(
  resolve(root, "db/patches/support/20260725_qualite_360_228_runtime_access.verify.sql"),
  "utf8"
);
const rollback = readFileSync(
  resolve(root, "db/patches/support/20260725_qualite_360_228_runtime_access.rollback.sql"),
  "utf8"
);

const qualityTables = [
  "quality_control_plan",
  "quality_control_plan_characteristic",
  "quality_measurement_revisions",
  "quality_release_decision",
  "quality_derogation",
  "quality_derogation_consumption",
  "non_conformity_analysis",
  "quality_command_receipts",
];

describe("#132 Qualite 360 runtime access migration guards", () => {
  it("is transactional, idempotent and leaves business data untouched", () => {
    expect(patch).toContain("BEGIN;");
    expect(patch).toContain("COMMIT;");
    expect(patch).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(patch).not.toMatch(/\bUPDATE\s+public\./i);
    expect(patch).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(patch).not.toMatch(/\bDROP\s+/i);
    expect(patch).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("requires the runtime role and the complete #228 baseline", () => {
    expect(patch).toContain("rolname = 'cerp_app'");
    expect(patch).toContain("#132 requires the cerp_app PostgreSQL role");
    for (const table of qualityTables) {
      expect(patch).toContain(`'${table}'`);
    }
    expect(patch).toContain("from the Qualite 360 #228 baseline");
  });

  it("hands every new Qualite 360 table to cerp_app", () => {
    expect(patch).toContain("ALTER TABLE public.%I OWNER TO cerp_app");
    expect(verify).toContain("expected cerp_app");
    expect(verify).toContain("'SELECT,INSERT,UPDATE'");
  });

  it("keeps support scripts environment-guarded", () => {
    for (const script of [preflight, verify, rollback]) {
      expect(script).toContain("current_database() <> 'cerp_test'");
      expect(script).toContain("\\set ON_ERROR_STOP on");
    }
  });

  it("keeps preflight and verification read-only", () => {
    for (const script of [preflight, verify]) {
      expect(script).not.toMatch(/\bINSERT\s+INTO\b/i);
      expect(script).not.toMatch(/\bUPDATE\s+public\./i);
      expect(script).not.toMatch(/\bDELETE\s+FROM\b/i);
      expect(script).not.toMatch(/\bALTER\s+TABLE\b/i);
      expect(script).not.toMatch(/\bDROP\s+/i);
    }
  });

  it("limits rollback to restoring the prior administrative owner", () => {
    expect(rollback).toContain("ALTER TABLE public.%I OWNER TO postgres");
    expect(rollback).not.toMatch(/\bDROP\s+/i);
    expect(rollback).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
