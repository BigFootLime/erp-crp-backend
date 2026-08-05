import { describe, expect, it } from "vitest";

import {
  assertTemplateIsSafe,
  dateInTimeZone,
  daysBetweenDateOnly,
  dueCadenceSteps,
  reminderSuggestionKey,
  renderReminderTemplate,
  retryDelayMinutes,
} from "./reminder-policy";

describe("ADV reminder policy domain", () => {
  it("uses the configured business timezone across a UTC day boundary", () => {
    const now = new Date("2026-03-29T22:30:00.000Z");
    expect(dateInTimeZone(now, "Europe/Paris")).toBe("2026-03-30");
    expect(daysBetweenDateOnly("2026-03-30", "2026-03-29")).toBe(1);
  });

  it("selects every cadence step due without duplicating unordered values", () => {
    expect(dueCadenceSteps([15, 1, 7, 7], 9)).toEqual([1, 7]);
    expect(reminderSuggestionKey(42, 7)).toBe(reminderSuggestionKey(42, 7));
    expect(reminderSuggestionKey(42, 7)).not.toBe(reminderSuggestionKey(42, 15));
  });

  it("rejects unsupported template data and renders the allow-list", () => {
    expect(() => assertTemplateIsSafe("Facture {{invoice_number}}", "{{bank_account}}"))
      .toThrow(/n'est pas autorisée/);
    assertTemplateIsSafe("Facture {{invoice_number}}", "Solde {{outstanding_amount}} {{currency}}");
    expect(
      renderReminderTemplate("{{invoice_number}} — {{outstanding_amount}} {{currency}}", {
        client_name: "ACME",
        invoice_number: "F-2026-001",
        due_date: "2026-08-01",
        outstanding_amount: "120.00",
        currency: "EUR",
        days_overdue: "7",
      })
    ).toBe("F-2026-001 — 120.00 EUR");
  });

  it("stops retrying when the governed retry schedule is exhausted", () => {
    expect(retryDelayMinutes([5, 30], 1)).toBe(5);
    expect(retryDelayMinutes([5, 30], 2)).toBe(30);
    expect(retryDelayMinutes([5, 30], 3)).toBeNull();
  });
});
