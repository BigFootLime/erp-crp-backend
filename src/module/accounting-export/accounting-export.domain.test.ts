import { describe, expect, it } from "vitest";

import {
  buildAccountingPreview,
  GenericDelimitedV1Adapter,
  type AccountingMappingConfig,
  type AccountingSourceDocument,
} from "./accounting-export.domain";

const mapping: AccountingMappingConfig = {
  delimiter: ";",
  sales_journal: "VE",
  credit_journal: "AV",
  bank_journal_by_mode: { VIREMENT: "BQ" },
  bank_account_by_mode: { VIREMENT: "512100" },
  default_bank_journal: null,
  default_bank_account: null,
  sales_account_by_tax: { "20": "707000", "5.5": "707100" },
  vat_output_account_by_tax: { "20": "445710", "5.5": "445711" },
  purchase_journal: "AC",
  supplier_credit_journal: "AA",
  purchase_account_by_tax_category: { "S:20": "601000", "K:0": "601100" },
  vat_input_account_by_tax_category: { "S:20": "445660", "K:0": "445662" },
  reverse_charge_output_account_by_tax_category: { "K:0": "445200" },
  self_assessed_vat_rate_by_tax_category: { "K:0": "20" },
  fx_gain_account: "766000",
  fx_loss_account: "666000",
  default_axes: { SITE: "CRP" },
};

function source(overrides: Partial<AccountingSourceDocument> = {}): AccountingSourceDocument {
  return {
    source_type: "INVOICE",
    source_id: "42",
    source_number: "FAC-2026-0042",
    source_updated_at: "2026-08-14T10:00:00.000000Z",
    entry_date: "2026-08-14",
    client_id: "042",
    third_party_account: "4110042",
    currency: "EUR",
    payment_mode: null,
    total_ex_tax: "100.00",
    total_tax: "20.00",
    total_incl_tax: "120.00",
    tax_breakdown: [{ tax_rate: "20.0000", total_ex_tax: "100.00", tax_amount: "20.00" }],
    claimed_batch_id: null,
    ...overrides,
  };
}

describe("accounting export domain", () => {
  it("produces a balanced invoice with exact cents and normalized tax mappings", () => {
    const preview = buildAccountingPreview([source()], mapping);
    expect(preview.findings).toEqual([]);
    expect(preview.currency_totals).toEqual([{ currency: "EUR", debit: "120.00", credit: "120.00", balanced: true }]);
    expect(preview.lines.map((line) => [line.account_number, line.debit, line.credit])).toEqual([
      ["4110042", "120.00", "0.00"],
      ["707000", "0.00", "100.00"],
      ["445710", "0.00", "20.00"],
    ]);
  });

  it("reverses debit and credit for a credit note", () => {
    const preview = buildAccountingPreview([source({ source_type: "CREDIT_NOTE", source_id: "7", source_number: "AV-7" })], mapping);
    expect(preview.findings).toEqual([]);
    expect(preview.lines.map((line) => [line.account_number, line.debit, line.credit])).toEqual([
      ["4110042", "0.00", "120.00"],
      ["707000", "100.00", "0.00"],
      ["445710", "20.00", "0.00"],
    ]);
  });

  it("maps a payment and blocks an unknown payment mode", () => {
    const payment = source({ source_type: "PAYMENT", source_id: "9", source_number: "PAY-9", payment_mode: "VIREMENT", total_ex_tax: "0.00", total_tax: "0.00", total_incl_tax: "120.00", tax_breakdown: [] });
    expect(buildAccountingPreview([payment], mapping).findings).toEqual([]);
    const blocked = buildAccountingPreview([{ ...payment, payment_mode: "CHEQUE" }], mapping);
    expect(blocked.findings).toContainEqual(expect.objectContaining({ code: "ACCOUNTING_PAYMENT_MAPPING_MISSING", severity: "BLOCKER" }));
  });

  it("creates balanced domestic supplier invoice and credit-note entries", () => {
    const invoice = source({
      source_type: "SUPPLIER_INVOICE",
      source_id: "11111111-1111-4111-8111-111111111111",
      source_number: "FF-42",
      third_party_account: "4010042",
      tax_breakdown: [{ tax_category: "S", tax_rate: "20", total_ex_tax: "100.00", tax_amount: "20.00" }],
    });
    const preview = buildAccountingPreview([invoice], mapping);
    expect(preview.findings).toEqual([]);
    expect(preview.lines.map((line) => [line.account_number, line.debit, line.credit])).toEqual([
      ["4010042", "0.00", "120.00"],
      ["601000", "100.00", "0.00"],
      ["445660", "20.00", "0.00"],
    ]);

    const credit = buildAccountingPreview([{ ...invoice, source_type: "SUPPLIER_CREDIT_NOTE", source_id: "22222222-2222-4222-8222-222222222222" }], mapping);
    expect(credit.findings).toEqual([]);
    expect(credit.lines.map((line) => [line.account_number, line.debit, line.credit])).toEqual([
      ["4010042", "120.00", "0.00"],
      ["601000", "0.00", "100.00"],
      ["445660", "0.00", "20.00"],
    ]);
  });

  it("autoliquidates a German intra-EU supplier invoice only from an explicit cabinet mapping", () => {
    const german = source({
      source_type: "SUPPLIER_INVOICE",
      source_id: "33333333-3333-4333-8333-333333333333",
      source_number: "DE-2026-18",
      third_party_account: "401DE18",
      partner_country_code: "DE",
      total_ex_tax: "100.00",
      total_tax: "0.00",
      total_incl_tax: "100.00",
      tax_breakdown: [{ tax_category: "K", tax_rate: "0", total_ex_tax: "100.00", tax_amount: "0.00" }],
    });
    const preview = buildAccountingPreview([german], mapping);
    expect(preview.findings).toEqual([]);
    expect(preview.currency_totals).toEqual([{ currency: "EUR", debit: "120.00", credit: "120.00", balanced: true }]);
    expect(preview.lines.map((line) => [line.account_number, line.debit, line.credit])).toEqual([
      ["401DE18", "0.00", "100.00"],
      ["601100", "100.00", "0.00"],
      ["445662", "20.00", "0.00"],
      ["445200", "0.00", "20.00"],
    ]);

    const blockedMapping = { ...mapping, self_assessed_vat_rate_by_tax_category: {} };
    expect(buildAccountingPreview([german], blockedMapping).findings).toContainEqual(
      expect.objectContaining({ code: "ACCOUNTING_REVERSE_CHARGE_MAPPING_MISSING", severity: "BLOCKER" })
    );
  });

  it("does not replace missing accounts or inconsistent tax data with zero", () => {
    const preview = buildAccountingPreview([source({ third_party_account: null, total_tax: "19.99" })], mapping);
    expect(preview.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "ACCOUNTING_THIRD_PARTY_ACCOUNT_MISSING",
      "ACCOUNTING_SOURCE_TOTAL_MISMATCH",
      "ACCOUNTING_TAX_BREAKDOWN_MISMATCH",
    ]));
  });

  it("blocks a source claimed by another generated batch", () => {
    const preview = buildAccountingPreview([source({ claimed_batch_id: "old-batch" })], mapping);
    expect(preview.findings).toContainEqual(expect.objectContaining({ code: "ACCOUNTING_SOURCE_ALREADY_EXPORTED" }));
  });

  it("renders deterministic UTF-8 CSV with escaping and a stable header", () => {
    const preview = buildAccountingPreview([source({ source_number: "FAC;42" })], mapping);
    const text = new GenericDelimitedV1Adapter().render(preview.lines, mapping).toString("utf8");
    expect(text.startsWith("\uFEFFJournalCode;EcritureDate;PieceRef")).toBe(true);
    expect(text).toContain('"FAC;42"');
    expect(text.endsWith("\r\n")).toBe(true);
  });
});
