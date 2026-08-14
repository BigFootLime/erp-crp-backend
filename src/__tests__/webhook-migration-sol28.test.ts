import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("SOL-28 migration safety contract", () => {
  const patch = read("db/patches/20260814_api_contract_webhooks_sol28.sql");
  const preflight = read("db/patches/support/20260814_api_contract_webhooks_sol28.preflight.sql");
  const verify = read("db/patches/support/20260814_api_contract_webhooks_sol28.verify.sql");
  const rollback = read("db/patches/support/20260814_api_contract_webhooks_sol28.rollback.sql");

  it("is transactional, additive and keeps secret material encrypted", () => {
    expect(patch).toMatch(/BEGIN;[\s\S]*COMMIT;/);
    expect(patch).toContain("secret_ciphertext");
    expect(patch).toContain("secret_iv");
    expect(patch).toContain("secret_tag");
    expect(patch).not.toMatch(/secret\s+text/i);
    expect(patch).toContain("api_webhook_delivery_attempts");
    expect(patch).toContain("api_webhook_command_receipts");
  });

  it("provides preflight, integrity verification and evidence-aware rollback", () => {
    expect(preflight).toContain("gen_random_uuid");
    expect(preflight).toContain("pg_database_size");
    expect(verify).toContain("immutable evidence triggers are incomplete");
    expect(verify).toContain(
      "NOT has_table_privilege('cerp_app', 'public.api_webhook_audit_events', 'SELECT,INSERT')",
    );
    expect(verify).not.toContain(
      "has_table_privilege('cerp_app', 'public.api_webhook_audit_events', 'UPDATE,DELETE')",
    );
    expect(verify).toContain("WHEN SQLSTATE '55000'");
    expect(verify).toMatch(/BEGIN;[\s\S]*SOL28_VERIFY_PROBE[\s\S]*ROLLBACK;/);
    expect(rollback).toContain("rollback refused: webhook business or audit evidence exists");
    expect(rollback).toContain("verify_rollback");
  });
});
