import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const patch = readFileSync(resolve(root, "db/patches/20260725_qualite_360_228.sql"), "utf8");
const preflight = readFileSync(
  resolve(root, "db/patches/support/20260725_qualite_360_228.preflight.sql"),
  "utf8"
);
const verify = readFileSync(
  resolve(root, "db/patches/support/20260725_qualite_360_228.verify.sql"),
  "utf8"
);
const rollback = readFileSync(
  resolve(root, "db/patches/support/20260725_qualite_360_228.rollback.sql"),
  "utf8"
);

describe("#228 migration guards", () => {
  it("keeps the forward patch transactional, additive and inactive", () => {
    expect(patch).toContain("BEGIN;");
    expect(patch).toContain("COMMIT;");
    expect(patch).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(patch).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(patch).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(patch).not.toMatch(/\bTRUNCATE\b/i);
    // The patch never creates a plan, a derogation, a release or a disposition.
    expect(patch).not.toMatch(/\bINSERT\s+INTO\s+public\.quality_control_plan\b/i);
    expect(patch).not.toMatch(/\bINSERT\s+INTO\s+public\.quality_derogation\b/i);
    expect(patch).not.toMatch(/\bINSERT\s+INTO\s+public\.quality_release_decision\b/i);
    expect(patch).not.toMatch(/\bINSERT\s+INTO\s+public\.non_conformity\b/i);
    // It never touches lot statuses or stock movements.
    expect(patch).not.toMatch(/\bUPDATE\s+public\.lots\b/i);
    expect(patch).not.toMatch(/\bINSERT\s+INTO\s+public\.stock_movements\b/i);
    // It never seeds or flips a setting.
    expect(patch).not.toMatch(/\bINSERT\s+INTO\s+public\.erp_settings\b/i);
  });

  it("refuses to run without the Qualité baseline", () => {
    expect(patch).toContain("#228 requires the Qualité baseline");
    expect(patch).toContain("#228 requires public.non_conformity");
  });

  it("creates the versioned plan referential", () => {
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.quality_control_plan");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.quality_control_plan_characteristic");
    expect(patch).toContain("quality_control_plan_code_version_228_uq UNIQUE (code, version)");
    expect(patch).toContain("quality_control_plan_status_228_ck");
    expect(patch).toContain("quality_control_plan_scope_228_ck");
    expect(patch).toContain("quality_plan_char_key_228_uq UNIQUE (plan_id, characteristic_key)");
    expect(patch).toContain("DEFERRABLE INITIALLY DEFERRED");
  });

  it("stores the applied snapshot with its SHA-256 fingerprint", () => {
    expect(patch).toContain("ADD COLUMN IF NOT EXISTS plan_snapshot jsonb");
    expect(patch).toContain("ADD COLUMN IF NOT EXISTS plan_snapshot_sha256 text");
    expect(patch).toContain("quality_control_snapshot_hash_228_ck");
    expect(patch).toContain("'^[a-f0-9]{64}$'");
    expect(patch).toContain("the applied quality plan snapshot is immutable");
  });

  it("enforces the quantity ledger in the database", () => {
    expect(patch).toContain("quality_control_qty_nonneg_228_ck");
    expect(patch).toContain("quality_control_qty_ledger_228_ck");
    expect(patch).toContain("VALIDATE CONSTRAINT quality_control_qty_nonneg_228_ck");
    expect(patch).toContain("VALIDATE CONSTRAINT quality_control_qty_ledger_228_ck");
    expect(patch).toContain("qty_conforming <= qty_controlled");
    expect(patch).toContain("qty_released <= qty_conforming");
    expect(patch).toContain("qty_consumed <= qty_released");
  });

  it("keeps published plans, measurements and evidence immutable", () => {
    expect(patch).toContain("a published quality control plan is immutable");
    expect(patch).toContain("characteristics of a published quality control plan are immutable");
    expect(patch).toContain(
      "a measurement of a validated quality control requires an audited revision"
    );
    expect(patch).toContain("quality audit evidence is immutable (append-only)");
    expect(patch).toContain("trg_quality_event_log_append_only_228");
    expect(patch).toContain("trg_quality_release_decision_append_only_228");
    expect(patch).toContain("trg_quality_derogation_consumption_append_only_228");
    expect(patch).toContain("trg_quality_command_receipts_append_only_228");
  });

  it("guards derogations: separation of duties, immutability and quantity cap", () => {
    expect(patch).toContain("quality_derogation_separation_228_ck");
    expect(patch).toContain("approved_by IS NULL OR approved_by <> requested_by");
    expect(patch).toContain("an approved or closed derogation is immutable");
    expect(patch).toContain("derogation consumption cannot decrease");
    expect(patch).toContain("derogation consumptions exceed the approved maximum quantity");
    expect(patch).toContain("a derogation must be approved before being consumed");
    expect(patch).toContain(
      "quality_derogation_consumption_release_228_uq UNIQUE (derogation_id, release_decision_id)"
    );
  });

  it("protects quality documents from hard deletion and hash rewriting", () => {
    expect(patch).toContain("quality documents are removed logically (removed_at), never deleted");
    expect(patch).toContain("a decision evidence document cannot be removed");
    expect(patch).toContain("quality document identity (hash, storage) is immutable");
  });

  it("extends historical enums additively instead of duplicating them", () => {
    for (const value of ["DRAFT", "DISPOSITION", "VERIFICATION", "CANCELLED"]) {
      expect(patch).toContain(`ALTER TYPE public.quality_nc_status ADD VALUE IF NOT EXISTS '${value}'`);
    }
    for (const value of ["PLAN", "DEROGATION", "RELEASE"]) {
      expect(patch).toContain(`ALTER TYPE public.quality_entity_type ADD VALUE IF NOT EXISTS '${value}'`);
    }
    expect(patch).not.toMatch(/\bDROP\s+TYPE\b/i);
    // New enum values must not be consumed inside the same transaction.
    expect(patch).not.toMatch(/quality_nc_status\s*=\s*'DISPOSITION'/i);
    expect(patch).not.toMatch(/status\s*=\s*'VERIFICATION'::public\.quality_nc_status/i);
  });

  it("keeps the historical disposition list and only adds RECHECK", () => {
    expect(patch).toContain("'HOLD', 'RELEASE', 'USE_AS_IS', 'REWORK', 'SORT', 'SCRAP', 'RETURN_SUPPLIER', 'RECHECK'");
    expect(patch).toContain("VALIDATE CONSTRAINT non_conformity_dispositions_type_check");
  });

  it("adds idempotency receipts and correlation on the audit journal", () => {
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.quality_command_receipts");
    expect(patch).toContain(
      "quality_command_receipts_actor_key_228_uq UNIQUE (actor_user_id, idempotency_key)"
    );
    expect(patch).toContain("char_length(idempotency_key) BETWEEN 8 AND 200");
    expect(patch).toContain("ADD COLUMN IF NOT EXISTS correlation_id uuid NULL");
    expect(patch).toContain("non_conformity_dispositions_idem_228_uq");
  });

  it("adds the 5 Why / 8D structure bounded and governed", () => {
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.non_conformity_analysis");
    expect(patch).toContain("method IN ('FIVE_WHY', 'EIGHT_D')");
    expect(patch).toContain("char_length(answer) <= 4000");
    expect(patch).toContain("non_conformity_analysis_step_228_uq");
  });

  it("links measurements to the instrument actually used", () => {
    expect(patch).toContain("ADD COLUMN IF NOT EXISTS instrument_id uuid");
    expect(patch).toContain("ADD COLUMN IF NOT EXISTS instrument_snapshot jsonb");
    expect(patch).toContain("quality_control_points_instrument_228_fkey");
    expect(patch).toContain("quality_control_points_sample_228_uq");
  });

  it("restricts every support script to cerp_test", () => {
    for (const script of [preflight, verify, rollback]) {
      expect(script).toContain("current_database() <> 'cerp_test'");
      expect(script).toContain("\\set ON_ERROR_STOP on");
    }
  });

  it("keeps preflight and verify read-only", () => {
    for (const script of [preflight, verify]) {
      expect(script).not.toMatch(/\bINSERT\s+INTO\b/i);
      expect(script).not.toMatch(/\bUPDATE\s+public\./i);
      expect(script).not.toMatch(/\bDELETE\s+FROM\b/i);
      expect(script).not.toMatch(/\bALTER\s+TABLE\b/i);
      expect(script).not.toMatch(/\bDROP\s+/i);
    }
  });

  it("refuses to roll back over recorded quality decisions", () => {
    expect(rollback).toContain("release decision(s) recorded");
    expect(rollback).toContain("derogation consumption(s) recorded");
    expect(rollback).toContain("measurement revision(s) recorded");
    expect(rollback).toContain("already carry a plan snapshot");
    expect(rollback).toContain("use an extended status");
    expect(rollback).toContain("use the new columns");
    expect(rollback).toContain("PostgreSQL cannot remove a value from an enum type");
  });

  it("declares itself in the patch inventory conventions", () => {
    expect(patch.startsWith("-- 20260725_qualite_360_228.sql")).toBe(true);
    expect(patch).toContain("Issue #228");
  });
});
