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

  it("keeps deduplicated intended recipients in production", () => {
    expect(resolveOutboundEmailRecipients(
      ["client@example.com", "client@example.com"],
      { CERP_ENVIRONMENT: "production", DATABASE_URL: "postgresql://db/cerp" } as NodeJS.ProcessEnv
    )).toEqual({ recipients: ["client@example.com"], rerouted: false });
  });
});
