import { describe, expect, it } from "vitest";

import { roleHasFinanceCapability } from "./finance-policy";

describe("ADV reminder fallback permissions", () => {
  it("separates policy administration from approval and delivery", () => {
    expect(roleHasFinanceCapability("Administrateur Systeme et Reseau", "reminder_policy_manage")).toBe(true);
    expect(roleHasFinanceCapability("Administrateur Systeme et Reseau", "reminder_send")).toBe(false);
    expect(roleHasFinanceCapability("Comptable", "reminder_approve")).toBe(true);
    expect(roleHasFinanceCapability("Comptable", "reminder_send")).toBe(true);
    expect(roleHasFinanceCapability("Secretaire", "reminder_send")).toBe(false);
  });
});
