import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("SOL-27 accounting export migration guards", () => {
  const patch = read("db/patches/20260814_accounting_export_sol27.sql");
  const preflight = read("db/patches/support/20260814_accounting_export_sol27.preflight.sql");
  const verify = read("db/patches/support/20260814_accounting_export_sol27.verify.sql");
  const rollback = read("db/patches/support/20260814_accounting_export_sol27.rollback.sql");

  it("persists versioned mappings, immutable entries, claims and command receipts", () => {
    for (const table of ["accounting_export_mapping_versions", "accounting_export_batches", "accounting_export_batch_sources", "accounting_export_entries", "accounting_export_source_claims", "accounting_export_command_receipts"]) {
      expect(patch).toContain(`public.${table}`);
    }
    expect(patch).toContain("accounting_source_active_claim_sol27_uq");
    expect(patch).toContain("fn_protect_accounting_export_sol27");
    expect(patch).toContain("artifact_sha256");
    expect(patch).toContain("old_row jsonb := to_jsonb(OLD)");
    expect(patch).not.toContain("AND OLD.document_status = 'ISSUED'");
    expect(patch).not.toContain("NEW.settlement_status");
  });

  it("ships executable preflight, verification and conservative rollback", () => {
    expect(preflight).toContain("server_version_num");
    expect(preflight).toContain("clients_without_third_party_account");
    expect(verify).toContain("unbalanced_currency_groups");
    expect(rollback).toContain("rollback refused");
    expect(rollback).toContain("DROP TABLE IF EXISTS public.accounting_export_mapping_versions");
  });
});
