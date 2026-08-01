import { describe, expect, it } from "vitest";

import { activateFinanceConfigurationBodySchema } from "./finance-configuration.validators";

const validCommand = {
  confirm: true,
  legal_entity_code: "b7c1e5a2-3f4d-4e8b-9a06-380569012000",
  policy_version: "finance-2026-v1",
  effective_from: "2026-01-01",
  effective_to: null,
  eligible_delivery_statuses: ["SHIPPED", "DELIVERED"],
  require_distinct_issuer: true,
  sequences: {
    facture: { year: 2026, prefix: "FAC-2026-", next_value: 1, padding: 6 },
  },
};

describe("activateFinanceConfigurationBodySchema", () => {
  it("accepts a confirmed command with the mandatory FACTURE sequence", () => {
    expect(activateFinanceConfigurationBodySchema.parse(validCommand)).toMatchObject(validCommand);
  });

  it("refuses a command that has not been explicitly confirmed", () => {
    expect(activateFinanceConfigurationBodySchema.safeParse({ ...validCommand, confirm: false }).success).toBe(false);
  });

  it("refuses statuses outside SHIPPED and DELIVERED", () => {
    expect(activateFinanceConfigurationBodySchema.safeParse({
      ...validCommand,
      eligible_delivery_statuses: ["PREPARED"],
    }).success).toBe(false);
  });

  it("refuses a sequence reset or unsafe next value", () => {
    expect(activateFinanceConfigurationBodySchema.safeParse({
      ...validCommand,
      sequences: { facture: { ...validCommand.sequences.facture, next_value: 0 } },
    }).success).toBe(false);
  });

  it("refuses spaces and control characters in policy versions and prefixes", () => {
    expect(activateFinanceConfigurationBodySchema.safeParse({ ...validCommand, policy_version: "finance 2026" }).success).toBe(false);
    expect(activateFinanceConfigurationBodySchema.safeParse({
      ...validCommand,
      sequences: { facture: { ...validCommand.sequences.facture, prefix: "FAC 2026" } },
    }).success).toBe(false);
  });
});
