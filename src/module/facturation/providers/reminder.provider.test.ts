import { describe, expect, it } from "vitest";

import { createReminderProvider, SandboxReminderProvider } from "./reminder.provider";

describe("sandbox reminder provider", () => {
  it("is deterministic and never exposes the recipient in its receipt", async () => {
    const provider = new SandboxReminderProvider();
    const input = {
      idempotencyKey: "suggestion:one",
      recipient: "adv@example.test",
      subject: "Facture F-1",
      body: "Solde 10 EUR",
      attachmentDocumentId: null,
    };
    const first = await provider.send(input);
    const second = await provider.send(input);
    expect(second.providerMessageId).toBe(first.providerMessageId);
    expect(JSON.stringify(first)).not.toContain(input.recipient);
  });

  it("fails closed when any non-sandbox provider is configured", () => {
    expect(() => createReminderProvider({ ADV_REMINDERS_PROVIDER: "smtp" } as NodeJS.ProcessEnv))
      .toThrow(/sandbox/);
  });
});
