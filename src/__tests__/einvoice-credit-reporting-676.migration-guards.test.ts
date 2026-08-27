import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const filename = "20260827_z_einvoice_credit_reporting_676.sql";
const patch = fs.readFileSync(path.join(root, "db/patches", filename), "utf8");
const preflight = fs.readFileSync(path.join(root, "db/patches/support/20260827_z_einvoice_credit_reporting_676.preflight.sql"), "utf8");
const verify = fs.readFileSync(path.join(root, "db/patches/support/20260827_z_einvoice_credit_reporting_676.verify.sql"), "utf8");
const rollback = fs.readFileSync(path.join(root, "db/patches/support/20260827_z_einvoice_credit_reporting_676.rollback.sql"), "utf8");
const runner = fs.readFileSync(path.join(root, "scripts/db-patches.js"), "utf8");
const reportingRepository = fs.readFileSync(
  path.join(root, "src/module/facturation/electronic-invoicing/electronic-invoice-reporting.repository.ts"),
  "utf8"
);
const sha256 = crypto.createHash("sha256").update(patch.replace(/\r\n?/g, "\n")).digest("hex");

describe("EINVOICE-676 migration guards", () => {
  it("pins the exact additive migration in the immutable production runner", () => {
    expect(sha256).toBe("1021100ef8b8d912dfaf690b1057d357582b73675e907fd5464d860d61ded5fe");
    expect(runner).toContain(`"${filename}"`);
    expect(runner).toContain(sha256);
  });

  it("keeps receipts and idempotency evidence append-only and limits runtime updates", () => {
    expect(patch).toContain("einvoice_reporting_receipts_append_only_676");
    expect(patch).toContain("einvoice_reporting_commands_append_only_676");
    expect(patch).toContain("einvoice_reporting_receipt_evidence_676_uq");
    expect(patch).not.toContain("GRANT SELECT, INSERT, UPDATE ON TABLE public.einvoice_reporting_transactions");
    expect(patch).toContain("GRANT UPDATE (period_id, status, provider_item_id");
  });

  it("does not invent a supplier BT-23 billing frame", () => {
    expect(reportingRepository).toContain("EREPORTING_BILLING_FRAME_REQUIRED");
    expect(reportingRepository).not.toContain('billingFrameCode: "S1"');
  });

  it("ships guarded preflight, verification and isolated rollback scripts", () => {
    expect(preflight).toContain("EINVOICE-676 missing prerequisites");
    expect(verify).toContain("append-only evidence triggers are incomplete");
    expect(rollback).toContain("allowed only on an isolated/test database");
    expect(rollback).toContain("rollback refused because reporting evidence exists");
  });
});
