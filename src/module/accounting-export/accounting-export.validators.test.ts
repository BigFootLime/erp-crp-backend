import { describe, expect, it } from "vitest";

import { createAccountingMappingSchema, createAccountingPreviewSchema } from "./accounting-export.validators";

describe("accounting export validators", () => {
  it("accepts a strict versioned generic mapping", () => {
    expect(createAccountingMappingSchema.safeParse({
      version_code: "CABINET-2026-V1",
      adapter_code: "GENERIC_DELIMITED_V1",
      effective_from: "2026-01-01",
      activate: true,
      config: {
        delimiter: ";", sales_journal: "VE", credit_journal: "AV",
        bank_journal_by_mode: {}, bank_account_by_mode: {}, default_bank_journal: "BQ",
        default_bank_account: "512000", sales_account_by_tax: { "20": "707000" },
        vat_output_account_by_tax: { "20": "445710" }, default_axes: {},
      },
    }).success).toBe(true);
  });

  it("rejects reversed periods, unsafe accounts and duplicate source types", () => {
    expect(createAccountingPreviewSchema.safeParse({ mapping_version_id: crypto.randomUUID(), period_from: "2026-08-31", period_to: "2026-08-01", source_types: ["INVOICE", "INVOICE"] }).success).toBe(false);
    const invalid = createAccountingMappingSchema.safeParse({ version_code: "V1", adapter_code: "GENERIC_DELIMITED_V1", effective_from: "2026-01-01", config: { delimiter: ";", sales_journal: "VE", credit_journal: "AV", bank_journal_by_mode: {}, bank_account_by_mode: {}, default_bank_journal: null, default_bank_account: null, sales_account_by_tax: { "20": "707 000" }, vat_output_account_by_tax: { "20": "445710" }, default_axes: {} } });
    expect(invalid.success).toBe(false);
  });
});
