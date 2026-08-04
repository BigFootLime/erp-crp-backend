import { describe, expect, it } from "vitest";
import { roleHasMarginCapability } from "../module/margin-engine/domain/margin-engine-policy";
import { createMarginInputSchema, createRateVersionSchema } from "../module/margin-engine/validators/margin-engine.validators";

describe("margin engine RBAC", () => {
  it("denies unknown roles by default and separates read from administration", () => {
    expect(roleHasMarginCapability(null, "read_costs")).toBe(false);
    expect(roleHasMarginCapability("Opérateur atelier", "read_costs")).toBe(false);
    expect(roleHasMarginCapability("Méthodes", "read_costs")).toBe(true);
    expect(roleHasMarginCapability("Méthodes", "manage_rates")).toBe(false);
    expect(roleHasMarginCapability("Contrôle de gestion", "manage_rates")).toBe(true);
  });
});

describe("margin engine write contracts", () => {
  it("requires an explicitly dated assumption", () => {
    const result = createMarginInputSchema.safeParse({
      scope_type: "OF", scope_ref: "42", basis: "ACTUAL", input_key: "transport",
      input_kind: "COST", category: "TRANSPORT", availability: "PROVIDED", amount_ht: 12,
      source_type: "MANUAL", assumption: "Forfait transporteur",
    });
    expect(result.success).toBe(false);
  });

  it("accepts explicit not-applicable and rejects a hidden value on it", () => {
    const base = {
      scope_type: "DEVIS" as const, scope_ref: "1", basis: "PLANNED" as const,
      input_key: "tooling", input_kind: "COST" as const, category: "TOOLING" as const,
      source_type: "USER_DECISION", availability: "NOT_APPLICABLE" as const,
    };
    expect(createMarginInputSchema.safeParse(base).success).toBe(true);
    expect(createMarginInputSchema.safeParse({ ...base, amount_ht: 0 }).success).toBe(false);
  });

  it("requires a source and effective date on every rate version", () => {
    const result = createRateVersionSchema.safeParse({
      code: "OPERATOR_2026", version: 1, effective_from: "2026-08-01",
      assumption_date: "2026-07-31", source: "Budget validé DG",
      rates: [{ rate_code: "OP", category: "OPERATOR", scope_type: "GLOBAL", amount: 55, unit: "EUR_PER_HOUR" }],
    });
    expect(result.success).toBe(true);
  });
});
