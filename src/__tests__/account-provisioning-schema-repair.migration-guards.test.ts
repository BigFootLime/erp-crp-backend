import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("SOL-02 account provisioning schema repair", () => {
  const read = (name: string) => fs.readFileSync(path.join(process.cwd(), "db", "patches", name), "utf8");

  it("recreates the final tables with runtime ownership and no public access", () => {
    const patch = read("20260811_account_provisioning_schema_repair.sql");
    const preflight = read("support/20260811_account_provisioning_schema_repair.preflight.sql");
    const verify = read("support/20260811_account_provisioning_schema_repair.verify.sql");
    const rollback = read("support/20260811_account_provisioning_schema_repair.rollback.sql");

    expect(patch).toMatch(/^BEGIN;/m);
    expect(patch).toMatch(/CREATE TABLE IF NOT EXISTS public\.password_reset_tokens/);
    expect(patch).toMatch(/CREATE TABLE IF NOT EXISTS public\.admin_account_invitations/);
    expect(patch).toMatch(/OWNER TO cerp_app/g);
    expect(patch).toMatch(/REVOKE ALL ON TABLE public\.password_reset_tokens FROM PUBLIC/);
    expect(patch).toMatch(/password_reset_tokens_actor_idempotency_uq/);
    expect(patch).toMatch(/admin_account_invitations_one_open_per_user_uq/);
    expect(preflight).toMatch(/current_database\(\) IN \('cerp_test', 'cerp_prod'\)/);
    expect(verify).toMatch(/reset_owner_is_cerp_app/);
    expect(verify).toMatch(/invitation_not_public/);
    expect(rollback).toMatch(/requires restoration of the validated pre-migration backup/);
  });
});
