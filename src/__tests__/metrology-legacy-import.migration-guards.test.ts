import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const base = "20261027_metrology_legacy_import_1460";
const patch = read(`db/patches/${base}.sql`);
const preflight = read(`db/patches/support/${base}.preflight.sql`);
const verify = read(`db/patches/support/${base}.verify.sql`);
const rollback = read(`db/patches/support/${base}.rollback.sql`);

describe("legacy metrology import migration guards", () => {
  it("keeps captured facts as typed immutable evidence under the runtime owner", () => {
    for (const table of ["metrologie_import_batches", "metrologie_import_source_files", "metrologie_import_raw_rows", "metrologie_legacy_observations"]) {
      expect(patch).toContain(`ALTER TABLE public.${table} OWNER TO cerp_app`);
      expect(verify).toContain(table);
    }
    expect(patch).toContain("metrologie_import_batches_manifest_object_ck");
    expect(patch).toContain("metrologie_import_batches_reconciliation_object_ck");
    expect(patch).toContain("metrologie_import_raw_rows_cells_object_ck");
    expect(patch).toContain("metrologie_import_raw_rows_normalized_object_ck");
    expect(patch).toContain("metrologie_import_raw_rows_diagnostic_array_ck");
    expect(patch).toContain("trg_protect_metrologie_import_batch_1460");
    expect(patch).toContain("batch evidence is immutable");
  });

  it("has a read-only prerequisite check and a rollback that refuses evidence loss", () => {
    expect(preflight).toContain("cerp_app_role_present");
    expect(preflight).toContain("metrologie_equipements");
    expect(verify).toContain("has_table_privilege('cerp_app'");
    expect(rollback).toContain("refusing rollback: legacy import evidence exists");
    expect(rollback).toMatch(/^BEGIN;/m);
    expect(rollback).toMatch(/COMMIT;\s*$/);
  });
});
