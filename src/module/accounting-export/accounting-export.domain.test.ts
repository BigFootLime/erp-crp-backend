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
