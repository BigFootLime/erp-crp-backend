import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const PATCH = path.join(ROOT, "db", "patches", "20260811_ged_antivirus_quarantine.sql");
const SUPPORT = path.join(ROOT, "db", "patches", "support", "20260811_ged_antivirus_quarantine");

describe("SOL-11 GED antivirus migration guards", () => {
  let patch: string;
  let preflight: string;
  let verify: string;
  let rollback: string;
  let smoke: string;

  beforeAll(() => {
    patch = fs.readFileSync(PATCH, "utf8");
    preflight = fs.readFileSync(`${SUPPORT}.preflight.sql`, "utf8");
    verify = fs.readFileSync(`${SUPPORT}.verify.sql`, "utf8");
    rollback = fs.readFileSync(`${SUPPORT}.rollback.sql`, "utf8");
    smoke = fs.readFileSync(`${SUPPORT}.smoke.sql`, "utf8");
  });

  it("models every required verdict and quarantine state", () => {
    for (const state of ["pending", "clean", "infected", "scan_failed"]) {
      expect(patch).toContain(`'${state}'`);
    }
    for (const state of ["pending", "quarantined", "released", "deleted"]) {
      expect(patch).toContain(`'${state}'`);
    }
    expect(patch).toContain("signature_version");
    expect(patch).toContain("scan_duration_ms");
    expect(patch).toContain("request_metadata");
  });

  it("prevents a version from referencing a non-clean verdict", () => {
    expect(patch).toContain("fn_ged_version_requires_clean_scan");
    expect(patch).toContain("verdict IS DISTINCT FROM 'clean'");
    expect(patch).toContain("GED_SCAN_REQUIRED");
    expect(patch).toContain("upload_session_id");
  });

  it("makes published verdicts immutable while allowing post-release file cleanup", () => {
    expect(patch).toContain("fn_ged_published_scan_immutable");
    expect(patch).toContain("OLD.status = 'PUBLISHED'");
    expect(patch).toContain("OLD.quarantine_key IS NULL AND NEW.quarantine_key IS NOT NULL");
    expect(patch).not.toContain("OR NEW.quarantine_key IS DISTINCT FROM OLD.quarantine_key");
  });

  it("ships read-only preflight/verification and a rehearsal-only rollback", () => {
    expect(preflight).toContain("BEGIN TRANSACTION READ ONLY");
    expect(preflight).toContain("postgres_version_supported");
    expect(verify).toContain("BEGIN TRANSACTION READ ONLY");
    expect(verify).toContain("no_version_without_clean_verdict");
    expect(verify).toContain("quarantine_keys_complete");
    expect(rollback).toContain("current_database() <> 'cerp_test'");
    expect(rollback).toContain("cerp.migration_rehearsal");
    expect(rollback).toContain("ROLLBACK REFUSED: SOL-11 document versions exist");
    expect(smoke).toContain("pending verdict was published");
    expect(smoke).toContain("published verdict was mutable");
    expect(smoke).toContain("ROLLBACK;");
  });
});
