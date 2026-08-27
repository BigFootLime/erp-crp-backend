import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const patch = fs.readFileSync(path.join(root, "db/patches/20260827_einvoice_regulatory_data_599.sql"), "utf8");
const preflight = fs.readFileSync(path.join(root, "db/patches/support/20260827_einvoice_regulatory_data_599.preflight.sql"), "utf8");
const verify = fs.readFileSync(path.join(root, "db/patches/support/20260827_einvoice_regulatory_data_599.verify.sql"), "utf8");
const rollback = fs.readFileSync(path.join(root, "db/patches/support/20260827_einvoice_regulatory_data_599.rollback.sql"), "utf8");
const runner = fs.readFileSync(path.join(root, "scripts/db-patches.js"), "utf8");
const sha256 = crypto.createHash("sha256").update(patch.replace(/\r\n?/g, "\n")).digest("hex");

describe("EINV-599 migration guards", () => {
  it("pins the exact additive migration in the immutable production runner", () => {
    expect(sha256).toBe("76f06374a17e0679e16befde6926068d1d012cf8e83dbb0deba77e2aedb56f0f");
    expect(runner).toContain('"20260827_einvoice_regulatory_data_599.sql"');
    expect(runner).toContain(sha256);
  });

  it("keeps BT-23 and verification commands versioned, explicit and append-only", () => {
    expect(patch.match(/AFNOR-XP-Z12-012-DGFIP-V3\.2-2026-04-30','[BSM]\d+'/g)).toHaveLength(13);
    expect(patch).toContain("trg_einvoice_billing_frame_append_only_599");
    expect(patch).toContain("trg_einvoice_directory_verification_append_only_599");
    expect(patch).not.toMatch(/UPDATE public\.(clients|fournisseurs|facture)\s+SET\s+(siren|billing_frame)/i);
    expect(patch).toContain("regulatory_snapshot jsonb NULL");
  });

  it("ships guarded preflight, verification and isolated rollback scripts", () => {
    expect(preflight).toContain("EINV-599 missing prerequisites");
    expect(verify).toContain("expected 13 BT-23 codes");
    expect(verify).toContain("directory verification command ledger is missing");
    expect(rollback).toContain("allowed only on an isolated/test database");
    expect(rollback).toContain("rollback refused because qualified regulatory data exists");
  });
});
