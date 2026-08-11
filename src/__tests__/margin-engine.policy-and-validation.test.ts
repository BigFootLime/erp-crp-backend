import { describe, expect, it } from "vitest";
import { canUseMarginCapability, roleHasMarginCapability } from "../module/margin-engine/domain/margin-engine-policy";
import { createMarginInputSchema, createRateVersionSchema } from "../module/margin-engine/validators/margin-engine.validators";

const evidenceContract = {
  definition: "Décision de coût documentée",
  unit: "EUR_HT",
  period_start: "2026-08-01",
  period_end: "2026-08-31",
  source_reliability: "DECLARED" as const,
};

describe("margin engine RBAC", () => {
  it("denies unknown roles by default and separates read from administration", () => {
    expect(roleHasMarginCapability(null, "read_costs")).toBe(false);
    expect(roleHasMarginCapability("Opérateur atelier", "read_costs")).toBe(false);
    expect(roleHasMarginCapability("Méthodes", "read_costs")).toBe(true);
    expect(roleHasMarginCapability("Méthodes", "manage_rates")).toBe(false);
    expect(roleHasMarginCapability("Contrôle de gestion", "manage_rates")).toBe(true);
  });

  it("does not turn reporting module access into financial administration", () => {
    expect(canUseMarginCapability("Opérateur atelier", "read_costs", true)).toBe(true);
    for (const capability of ["manage_rates", "manage_inputs", "snapshot", "export"] as const) {
      expect(canUseMarginCapability("Opérateur atelier", capability, true)).toBe(false);
    }
    expect(canUseMarginCapability("Contrôle de gestion", "export", false)).toBe(true);
    expect(canUseMarginCapability("Directeur", "snapshot", false)).toBe(true);
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
      scope_type: "DEVIS" as const, scope_ref: "1", basis: "QUOTED" as const,
      input_key: "tooling", input_kind: "COST" as const, category: "TOOLING" as const,
      source_type: "USER_DECISION", availability: "NOT_APPLICABLE" as const,
      ...evidenceContract,
    };
    expect(createMarginInputSchema.safeParse(base).success).toBe(true);
    expect(createMarginInputSchema.safeParse({ ...base, amount_ht: 0 }).success).toBe(false);
  });

  it("requires a source and effective date on every rate version", () => {
    const result = createRateVersionSchema.safeParse({
      code: "OPERATOR_2026", version: 1, effective_from: "2026-08-01",
      assumption_date: "2026-07-31", source: "Budget validé DG", source_reliability: "DECLARED",
      rates: [{ rate_code: "OP", category: "OPERATOR", scope_type: "GLOBAL", amount: 55, unit: "EUR_PER_HOUR" }],
    });
    expect(result.success).toBe(true);
  });

  it("requires a rate application date and exactly one amount source", () => {
    const base = {
      scope_type: "OF" as const, scope_ref: "42", basis: "ACTUAL" as const,
      input_key: "operator", input_kind: "COST" as const, category: "OPERATOR" as const,
      availability: "PROVIDED" as const, source_type: "RATE_INPUT",
      rate_id: "11111111-1111-4111-8111-111111111111", quantity: 2,
      ...evidenceContract,
    };
    expect(createMarginInputSchema.safeParse(base).success).toBe(false);
    expect(createMarginInputSchema.safeParse({ ...base, rate_effective_at: "2026-08-05" }).success).toBe(true);
    expect(createMarginInputSchema.safeParse({ ...base, rate_effective_at: "2026-08-05", amount_ht: 100 }).success).toBe(false);
  });
});
