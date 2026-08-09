import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("SOL-02 account provisioning migration guards", () => {
  const read = (name: string) => fs.readFileSync(path.join(process.cwd(), "db", "patches", name), "utf8");

  it("ships forward, preflight, verification and evidence-preserving rollback", () => {
    const patch = read("20260809_account_invitation_activation.sql");
    const preflight = read("support/20260809_account_invitation_activation.preflight.sql");
    const verify = read("support/20260809_account_invitation_activation.verify.sql");
    const rollback = read("support/20260809_account_invitation_activation.rollback.sql");

    expect(patch).toMatch(/UNIQUE \(created_by, idempotency_key\)/);
    expect(patch).toMatch(/admin_account_invitations_one_open_per_user_uq/);
    expect(patch).toMatch(/password_reset_tokens_actor_idempotency_uq/);
    expect(preflight).toMatch(/password_reset_tokens/);
    expect(verify).toMatch(/invitation_rows_are_valid/);
    expect(verify).toMatch(/admin_reset_rows_are_valid/);
    expect(rollback).toMatch(/Account invitation evidence exists/);
    expect(rollback).toMatch(/Administrative reset evidence exists/);
  });
});
