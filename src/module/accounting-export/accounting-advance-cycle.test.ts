import { describe, expect, it } from "vitest";
import { buildAccountingPreview, type AccountingSourceDocument, type AccountingMappingConfig } from "./accounting-export.domain";
import { accountingFinanceKind } from "./accounting-finance-kind";
import { planAdvanceVat } from "../facturation/domain/advance-vat";
import { moneyToCents } from "../facturation/domain/decimal-money";

const mapping: AccountingMappingConfig = { delimiter: ";", sales_journal: "VE", credit_journal: "AV", bank_journal_by_mode: {}, bank_account_by_mode: {},
  default_bank_journal: "BQ", default_bank_account: "512000", sales_account_by_tax: { "20": "701000" }, vat_output_account_by_tax: { "20": "445710" },
  advance_account_by_tax: { "20": "419100" }, advance_vat_pending_account_by_tax: { "20": "445800" }, default_axes: {} };
const base: AccountingSourceDocument = { source_type: "INVOICE", source_id: "1", source_number: "FIXTURE", source_updated_at: "2026-10-14T08:00:00Z",
  entry_date: "2026-10-14", client_id: "fixture", third_party_account: "411FIXTURE", currency: "EUR", payment_mode: "VIREMENT", total_ex_tax: "100.00",
  total_tax: "20.00", total_incl_tax: "120.00", tax_breakdown: [{ tax_rate: "20", total_ex_tax: "100.00", tax_amount: "20.00" }], claimed_batch_id: null };
describe("advance cash then final invoice ledger", () => {
  it("clears the advance and pending VAT, with bank, sales and final VAT counted once", () => {
    const first = planAdvanceVat({ invoiceId: 1, invoiceSha256: "a".repeat(64), invoiceGross: "120.00", allocationAmount: "80.00", originalTax: base.tax_breakdown, prior: [] });
    const second = planAdvanceVat({ invoiceId: 1, invoiceSha256: "a".repeat(64), invoiceGross: "120.00", allocationAmount: "40.00", originalTax: base.tax_breakdown, prior: [first] });
    const vat = [first, second].map((s, i): AccountingSourceDocument => ({ ...base, source_type: "ADVANCE_VAT", source_id: "VAT-" + i,
      total_ex_tax: "0.00", total_tax: s.entries[0].tax_amount, total_incl_tax: s.entries[0].tax_amount,
      tax_breakdown: [{ tax_rate: "20", total_ex_tax: "0.00", tax_amount: s.entries[0].tax_amount }], advance_vat_snapshot: s }));
    const final = accountingFinanceKind({ ...base, source_id: "2", total_ex_tax: "200.00", total_tax: "40.00", total_incl_tax: "240.00",
      tax_breakdown: [{ tax_rate: "20", total_ex_tax: "200.00", tax_amount: "40.00" }], fiscal_snapshot: { invoice_type_code: 380,
        prepayments: { version: 1, amount_paid: "120.00", amount_due: "120.00" }, advance_clearing: { version: 1, amount_incl_tax: "120.00", entries: [{
          deposit_invoice_id: 1, deposit_invoice_sha256: "a".repeat(64), payment_allocation_id: "11111111-1111-4111-8111-111111111111",
          deposit_source_id: "22222222-2222-4222-8222-222222222222", tax_rate: "20.0000", amount_ex_tax: "100.00", tax_amount: "20.00", amount_incl_tax: "120.00" }] } } });
    const result = buildAccountingPreview([accountingFinanceKind({ ...base, fiscal_snapshot: { invoice_type_code: 386 } }), ...vat, final,
      ...["80.00", "40.00"].map((amount, i): AccountingSourceDocument => ({ ...base, source_type: "PAYMENT", source_id: "PAY-" + i,
        total_ex_tax: "0.00", total_tax: "0.00", total_incl_tax: amount, tax_breakdown: [] }))], mapping);
    expect(result.findings).toEqual([]);
    const balance = (account: string) => result.lines.filter(line => line.account_number === account)
      .reduce((sum, line) => sum + moneyToCents(line.debit) - moneyToCents(line.credit), 0n);
    expect(balance("512000")).toBe(12000n); expect(balance("701000")).toBe(-20000n);
    expect(balance("445710")).toBe(-4000n); expect(balance("419100")).toBe(0n); expect(balance("445800")).toBe(0n);
    expect(balance("411FIXTURE")).toBe(12000n); expect(result.currency_totals[0].balanced).toBe(true);
  });
  it("rejects changed clearing totals rather than hiding an unmatched cent", () => {
    const invalid = accountingFinanceKind({ ...base, fiscal_snapshot: { prepayments: { version: 1, amount_paid: "80.00", amount_due: "40.00" },
      advance_clearing: { version: 1, amount_incl_tax: "79.99", entries: [] } } });
    expect(buildAccountingPreview([invalid], mapping).lines).toEqual([]);
    expect(invalid.financial_context_error).toBeDefined();
  });
});
