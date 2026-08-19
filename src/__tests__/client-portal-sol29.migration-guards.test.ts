import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("SOL-29 migration guards", () => {
  const patch = read("db/patches/20260814_client_portal_sol29.sql");
  const preflight = read("db/patches/support/20260814_client_portal_sol29.preflight.sql");
  const verify = read("db/patches/support/20260814_client_portal_sol29.verify.sql");
  const rollback = read("db/patches/support/20260814_client_portal_sol29.rollback.sql");
  const authAttemptGrant = read("db/patches/20260819_client_portal_auth_attempt_update_grant_004.sql");
  const authAttemptGrantPreflight = read("db/patches/support/20260819_client_portal_auth_attempt_update_grant_004.preflight.sql");
  const authAttemptGrantVerify = read("db/patches/support/20260819_client_portal_auth_attempt_update_grant_004.verify.sql");
  const authAttemptGrantRollback = read("db/patches/support/20260819_client_portal_auth_attempt_update_grant_004.rollback.sql");

  it("keeps portal identities separate and tenant projections filtered", () => {
    expect(patch).toContain("client_portal_accounts");
    expect(patch).toContain("client_id varchar(3) NOT NULL REFERENCES public.clients");
    expect(patch).toContain("WITH (security_barrier = true)");
    expect(patch).toContain("client_portal_orders_v");
    expect(patch).toContain("client_portal_deliveries_v");
    expect(patch).toContain("client_portal_invoices_v");
    expect(patch).not.toContain("REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,\n  email_normalized");
  });

  it("protects audit, acknowledgement and idempotency evidence", () => {
    expect(patch.match(/fn_client_portal_evidence_immutable_sol29/g)?.length).toBeGreaterThanOrEqual(4);
    expect(patch).toContain("CLIENT_PORTAL_RECEIPT_UQ".toLowerCase());
    expect(verify).toContain("cross-client acknowledgement row(s)");
    expect(verify).toContain("immutable audit trigger did not reject an update");
  });

  it("enforces acknowledgement isolation inside PostgreSQL", () => {
    expect(patch).toContain("fn_client_portal_ack_tenant_guard_sol29");
    expect(patch).toContain("cross-client acknowledgement refused");
    expect(verify).toContain("cross-client acknowledgement was accepted");
  });

  it("ships preflight, verification and guarded rollback", () => {
    expect(preflight).toContain("gen_random_uuid() is unavailable");
    expect(verify).toContain("cerp_app grants are invalid");
    expect(rollback).toContain("rollback refused");
    expect(rollback).toContain("portal identity, publication or audit evidence exists");
  });

  it("grants only the portal auth-attempt state transition used after successful activation", () => {
    expect(authAttemptGrant).toContain("GRANT UPDATE ON TABLE public.client_portal_auth_attempts TO cerp_app");
    expect(authAttemptGrant).not.toMatch(/GRANT\s+ALL\s+/i);
    expect(authAttemptGrantPreflight).toContain("client_portal_auth_attempts");
    expect(authAttemptGrantVerify).toContain("cannot mark portal authentication attempts successful");
    expect(authAttemptGrantRollback).toContain("verified pre-migration backup");
    expect(authAttemptGrantRollback).not.toMatch(/REVOKE\s+UPDATE/i);
  });
});
