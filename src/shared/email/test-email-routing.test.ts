import { describe, expect, it } from "vitest";

import {
  TEST_EMAIL_RECIPIENTS,
  isTestEmailEnvironment,
  resolveOutboundEmailRecipients,
  testSafeEmailSubject,
} from "./test-email-routing";

describe("test email routing safety boundary", () => {
  it("detects the deployed test database without exposing its credentials", () => {
    expect(isTestEmailEnvironment({ DATABASE_URL: "postgresql://user:secret@db/cerp_test" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isTestEmailEnvironment({ CERP_ENVIRONMENT: "test" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isTestEmailEnvironment({ CERP_ENVIRONMENT: "production", DATABASE_URL: "postgresql://db/cerp" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("replaces every intended test recipient with the two internal mailboxes", () => {
    const delivery = resolveOutboundEmailRecipients(
      ["client@example.com", "another-client@example.com"],
      { CERP_ENVIRONMENT: "test" } as NodeJS.ProcessEnv
    );

    expect(delivery).toEqual({ recipients: [...TEST_EMAIL_RECIPIENTS], rerouted: true });
    expect(delivery.recipients).not.toContain("client@example.com");
    expect(testSafeEmailSubject("Accuse de reception", delivery.rerouted)).toMatch(/^\[TEST/);
  });

  it("keeps only fixture recipients inside the managed SOL-05 email sink", () => {
    const env = {
      NODE_ENV: "test",
      CERP_E2E_ISOLATED: "1",
      CERP_E2E_MANAGED_STACK: "1",
      CERP_E2E_EMAIL_SINK: "1",
    } as NodeJS.ProcessEnv;

    expect(resolveOutboundEmailRecipients(["client@example.local", "client@example.local"], env)).toEqual({
      recipients: ["client@example.local"],
      rerouted: false,
    });
    expect(() => resolveOutboundEmailRecipients(["client@example.com"], env)).toThrow(/example\.local/);
    expect(() => resolveOutboundEmailRecipients([], env)).toThrow(/example\.local/);
  });

  it("keeps deduplicated intended recipients in production", () => {
    expect(resolveOutboundEmailRecipients(
      ["client@example.com", "client@example.com"],
      { CERP_ENVIRONMENT: "production", DATABASE_URL: "postgresql://db/cerp" } as NodeJS.ProcessEnv
    )).toEqual({ recipients: ["client@example.com"], rerouted: false });
  });
});
