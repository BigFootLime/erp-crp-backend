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

  it("replaces every intended test recipient with the authorized recipe mailbox only", () => {
    const delivery = resolveOutboundEmailRecipients(
      ["client@example.com", "another-client@example.com"],
      { CERP_ENVIRONMENT: "test" } as NodeJS.ProcessEnv
    );

    expect(delivery).toEqual({ recipients: [...TEST_EMAIL_RECIPIENTS], rerouted: true });
    expect(delivery.recipients).toEqual(["kesmartin2004@croix-rousse-precision.fr"]);
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

  it("routes Test ARs only to the authenticated sender supplied by the server", () => {
    const env = { DATABASE_URL: "postgresql://db/cerp_test" } as NodeJS.ProcessEnv;
    expect(resolveOutboundEmailRecipients(["customer@example.com"], env, "ghislaine@example.test"))
      .toEqual({ recipients: ["ghislaine@example.test"], rerouted: true });
    expect(resolveOutboundEmailRecipients(["customer@example.com"], env, "other-user@example.test"))
      .toEqual({ recipients: ["other-user@example.test"], rerouted: true });
    for (const invalid of [null, "", "bad-email", "a@example.test,b@example.test", "a@example.test\nBcc: customer@example.com"]) {
      expect(() => resolveOutboundEmailRecipients(["customer@example.com"], env, invalid))
        .toThrow("TEST_EMAIL_SENDER_EMAIL_REQUIRED");
    }
  });

  it("keeps deduplicated intended recipients in production", () => {
    expect(resolveOutboundEmailRecipients(
      ["client@example.com", "client@example.com"],
      { CERP_ENVIRONMENT: "production", DATABASE_URL: "postgresql://db/cerp" } as NodeJS.ProcessEnv
    )).toEqual({ recipients: ["client@example.com"], rerouted: false });
    expect(resolveOutboundEmailRecipients(["client@example.com"], { CERP_ENVIRONMENT: "production", DATABASE_URL: "postgresql://db/cerp_prod" } as NodeJS.ProcessEnv, "sender@example.test"))
      .toEqual({ recipients: ["client@example.com"], rerouted: false });
  });
});
