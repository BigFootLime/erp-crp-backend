import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { repoRoot } from "./helpers/repo-paths";

const patchPath = resolve(repoRoot, "db/patches/20260805_adv_reminders.sql");
const patch = readFileSync(patchPath, "utf8");
const preflight = readFileSync(
  resolve(repoRoot, "db/patches/support/20260805_adv_reminders.preflight.sql"),
  "utf8"
);
const verify = readFileSync(
  resolve(repoRoot, "db/patches/support/20260805_adv_reminders.verify.sql"),
  "utf8"
);
const rollback = readFileSync(
  resolve(repoRoot, "db/patches/support/20260805_adv_reminders.rollback.sql"),
  "utf8"
);
const repository = readFileSync(
  resolve(repoRoot, "src/module/facturation/repository/reminders.repository.ts"),
  "utf8"
);
const provider = readFileSync(
  resolve(repoRoot, "src/module/facturation/providers/reminder.provider.ts"),
  "utf8"
);
const validators = readFileSync(
  resolve(repoRoot, "src/module/facturation/validators/reminders.validators.ts"),
  "utf8"
);

const sha256 = createHash("sha256").update(patch.replace(/\r\n?/g, "\n")).digest("hex");

describe("FEAT-CERP-0002 migration and runtime guards", () => {
  it("pins lifecycle scripts to the exact immutable migration", () => {
    for (const support of [preflight, verify, rollback]) expect(support).toContain(sha256);
    expect(preflight).toContain("BEGIN TRANSACTION READ ONLY");
    expect(verify).toContain("BEGIN TRANSACTION READ ONLY");
    expect(rollback).toContain("cerp.allow_adv_reminder_rollback");
    expect(rollback).toContain("usage evidence exists; rollback refused");
  });

  it("enforces one invoice/cadence identity and concurrent skip-locked claims", () => {
    expect(patch).toContain("adv_reminder_suggestions_invoice_cadence_uniq");
    expect(repository).toContain("ON CONFLICT (facture_id,cadence_step_days) DO NOTHING");
    expect(repository).toContain("FOR UPDATE OF s SKIP LOCKED");
    expect(repository).toContain("claim_token=$2::uuid");
    expect(verify).toContain("invoice/cadence idempotence is violated");
  });

  it("uses the canonical three-character CERP client identifier", () => {
    expect(patch.match(/client_id varchar\(3\) NOT NULL/g)).toHaveLength(2);
    expect(patch).not.toMatch(/client_id uuid/i);
    expect(repository).not.toMatch(/client_id\s*=\s*\$\d+::uuid/);
    expect(validators).toContain("z.string().trim().min(1).max(3)");
  });

  it("cancels pending or claimed work in the payment and credit transaction", () => {
    expect(patch).toContain("adv_reminder_cancel_on_payment_allocation");
    expect(patch).toContain("adv_reminder_cancel_on_credit_allocation");
    expect(patch).toContain("SUGGESTION_CANCELLED_BY_FINANCE_CHANGE");
    expect(patch).toContain("'CLAIMED'");
    expect(patch).toContain("claim_token=NULL");
  });

  it("keeps all evidence append-only and recipients minimized", () => {
    expect(patch).toContain("adv_reminder_events_append_only");
    expect(patch).toContain("adv_reminder_attempts_append_only");
    expect(patch).toContain("adv_reminder_receipts_append_only");
    expect(patch).toContain("recipient_hash");
    expect(patch).not.toContain("recipient_email text");
  });

  it("contains no real sending provider or network transport", () => {
    expect(provider).toContain("Deliberately network-free provider");
    expect(provider).toContain("configured !== \"sandbox\"");
    expect(provider).not.toMatch(/fetch\(|axios|smtp|resend|sendgrid/i);
    expect(patch).toContain("provider='sandbox'");
  });
});
