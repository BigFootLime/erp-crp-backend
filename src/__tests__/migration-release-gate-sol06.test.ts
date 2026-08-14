import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const gate = require("../../scripts/migrations/release-gate.js") as {
  SOL06_PATCH: string;
  expectedRehearsalPatches: () => string[];
  inventory: () => {
    patches: Array<{
      filename: string;
      support: { preflight: boolean; verify: boolean; rollback: boolean };
      sha256: string;
    }>;
  };
  validateBackup: (filename: string, expectedSha: string) => {
    bytes: number;
    sha256: string;
  };
  KNOWN_EXTERNAL_APPLIED_PATCHES: Record<string, string>;
  classifyPatchLedgerRows: (
    applied: Array<{ filename: string; sha256: string }>,
    local: Array<{ filename: string; sha256: string }>,
  ) => {
    checksum_mismatches: string[];
    known_external_applied: string[];
    unknown_applied: string[];
  };
};

const ROOT = path.resolve(__dirname, "..", "..");
const PATCH = path.join(ROOT, "db", "patches", "20260810_system_reference_data_readiness.sql");
const SUPPORT = path.join(ROOT, "db", "patches", "support", "20260810_system_reference_data_readiness");
const MIGRATOR = path.join(ROOT, "scripts", "e2e", "migrate-isolated.js");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("SOL-06 migration release gate", () => {
  it("inventorie le patch canonique avec son trio preflight/verify/rollback", () => {
    const report = gate.inventory();
    const entry = report.patches.find((patch) => patch.filename === gate.SOL06_PATCH);

    expect(entry).toBeDefined();
    expect(entry?.support).toEqual({ preflight: true, verify: true, rollback: true });
    expect(entry?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const filenames = report.patches.map((patch) => patch.filename);
    expect(filenames).toEqual([...filenames].sort());
    expect(filenames.indexOf(gate.SOL06_PATCH)).toBeGreaterThanOrEqual(0);
    expect(gate.expectedRehearsalPatches()).toEqual(filenames.slice(filenames.indexOf(gate.SOL06_PATCH)));
    expect(gate.expectedRehearsalPatches()).toContain("20260811_production_readiness_center.sql");
  });

  it("porte les métadonnées décisionnelles et bloque les trois flux côté base", () => {
    const sql = fs.readFileSync(PATCH, "utf8");

    for (const column of ["definition", "unit", "period_start", "source", "freshness_at", "reliability"]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain("ERRCODE = 'P2606'");
    expect(sql).toContain("trg_stock_reference_readiness_2606");
    expect(sql).toContain("trg_production_reference_readiness_2606");
    expect(sql).toContain("trg_planning_reference_readiness_2606");
    expect(sql).not.toMatch(/INSERT INTO public\.erp_settings[\s\S]*stock\.valuation_method/i);
  });

  it("reste compatible avec le schéma terrain warehouse/location sans statut actif", () => {
    const sql = fs.readFileSync(PATCH, "utf8");
    const preflight = fs.readFileSync(`${SUPPORT}.preflight.sql`, "utf8");
    const bootstrap = fs.readFileSync(path.join(ROOT, "db", "e2e", "legacy-bootstrap.sql"), "utf8");

    expect(sql).not.toMatch(/(?:l|w)\.is_active/);
    expect(preflight).not.toMatch(/(?:l|w)\.is_active/);
    expect(preflight).not.toContain("no active warehouse/magasin/emplacement/location chain");
    const warehouseTable = bootstrap.match(/CREATE TABLE public\.warehouses \([\s\S]*?\n\);/)?.[0];
    const locationTable = bootstrap.match(/CREATE TABLE public\.locations \([\s\S]*?\n\);/)?.[0];
    expect(warehouseTable).not.toContain("is_active");
    expect(locationTable).not.toContain("is_active");
    expect(locationTable).toContain("description text");
  });

  it("rend le preflight lecture seule et le rollback explicitement test-only", () => {
    const preflight = fs.readFileSync(`${SUPPORT}.preflight.sql`, "utf8");
    const verify = fs.readFileSync(`${SUPPORT}.verify.sql`, "utf8");
    const rollback = fs.readFileSync(`${SUPPORT}.rollback.sql`, "utf8");

    expect(preflight).toContain("BEGIN TRANSACTION READ ONLY");
    expect(preflight).toContain("stock.valuation_method");
    expect(verify).toContain("expected guided readiness checks are missing");
    expect(verify).toContain("ACTIVE_STOCK_LOCATIONS");
    expect(verify).toContain("ACTIVE_PRODUCTION_CALENDAR");
    expect(verify).toContain("CURRENT_COST_CENTER_RATES");
    expect(verify).not.toContain("reference-data readiness contains blocking findings");
    expect(verify).toContain("contype = 'f' AND NOT convalidated");
    expect(rollback).toContain("current_database() <> 'cerp_test'");
    expect(rollback).toContain("cerp.migration_rehearsal");
  });

  it("n'autorise l'arrêt avant patch que pour la répétition SOL-06 isolée", () => {
    const migrator = fs.readFileSync(MIGRATOR, "utf8");

    expect(migrator).toContain("CERP_MIGRATION_REHEARSAL !== '1'");
    expect(migrator).toContain("20260810_system_reference_data_readiness.sql");
    expect(migrator).toContain("stop-before is reserved for the SOL-06 isolated rehearsal");
  });

  it("ecrit le rapport de repetition hors du worktree quand le gate le demande", () => {
    const source = fs.readFileSync(path.join(ROOT, "scripts", "migrations", "release-gate.js"), "utf8");

    expect(source).toContain('options["report-dir"]');
    expect(source).toContain('path.join(reportDir, "MIGRATION_REHEARSAL_SOL_06.json")');
    expect(source).toContain('path.join(reportDir, "MIGRATION_REHEARSAL_SOL_06.md")');
  });

  it("attend le serveur PostgreSQL final au lieu du serveur temporaire d'initialisation", () => {
    const source = fs.readFileSync(path.join(ROOT, "scripts", "migrations", "release-gate.js"), "utf8");

    expect(source).toContain("PostgreSQL init process complete; ready for start up")
    expect(source).toContain("consecutiveReady >= 2")
    expect(source).toContain("final server did not become stably ready")
  });

  it("refuse une sauvegarde vide ou dont le SHA-256 ne correspond pas", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cerp-sol06-test-"));
    temporaryDirectories.push(directory);
    const backup = path.join(directory, "source.dump");
    fs.writeFileSync(backup, "isolated-backup-proof");
    const validSha = crypto.createHash("sha256").update("isolated-backup-proof").digest("hex");

    expect(gate.validateBackup(backup, validSha)).toMatchObject({ bytes: 21, sha256: validSha });
    expect(() => gate.validateBackup(backup, "0".repeat(64))).toThrow("backup SHA-256 mismatch");
  });

  it("reconnaît uniquement le patch GED historique avec son checksum terrain exact", () => {
    const filename = "20260731_ged_fiches_360.sql";
    const expected = gate.KNOWN_EXTERNAL_APPLIED_PATCHES[filename];
    const exact = gate.classifyPatchLedgerRows([{ filename, sha256: expected }], []);
    expect(exact.known_external_applied).toEqual([filename]);
    expect(exact.checksum_mismatches).toEqual([]);
    expect(exact.unknown_applied).toEqual([]);

    const changed = gate.classifyPatchLedgerRows([{ filename, sha256: "0".repeat(64) }], []);
    expect(changed.checksum_mismatches).toEqual([filename]);
    expect(changed.known_external_applied).toEqual([]);

    const unknown = gate.classifyPatchLedgerRows([{ filename: "untracked.sql", sha256: "1".repeat(64) }], []);
    expect(unknown.unknown_applied).toEqual(["untracked.sql"]);
  });
});
