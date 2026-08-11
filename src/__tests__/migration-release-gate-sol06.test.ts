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

  it("rend le preflight lecture seule et le rollback explicitement test-only", () => {
    const preflight = fs.readFileSync(`${SUPPORT}.preflight.sql`, "utf8");
    const verify = fs.readFileSync(`${SUPPORT}.verify.sql`, "utf8");
    const rollback = fs.readFileSync(`${SUPPORT}.rollback.sql`, "utf8");

    expect(preflight).toContain("BEGIN TRANSACTION READ ONLY");
    expect(preflight).toContain("stock.valuation_method");
    expect(verify).toContain("WHERE NOT ready");
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

  it("refuse une sauvegarde vide ou dont le SHA-256 ne correspond pas", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cerp-sol06-test-"));
    temporaryDirectories.push(directory);
    const backup = path.join(directory, "source.dump");
    fs.writeFileSync(backup, "isolated-backup-proof");
    const validSha = crypto.createHash("sha256").update("isolated-backup-proof").digest("hex");

    expect(gate.validateBackup(backup, validSha)).toMatchObject({ bytes: 21, sha256: validSha });
    expect(() => gate.validateBackup(backup, "0".repeat(64))).toThrow("backup SHA-256 mismatch");
  });
});
