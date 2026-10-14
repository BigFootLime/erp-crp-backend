import { describe, expect, it } from "vitest";
import { planAdvanceVat, type AdvanceVatSnapshot } from "./advance-vat";
import { moneyToCents } from "./decimal-money";

const facts = { invoiceId: 1, invoiceSha256: "a".repeat(64), invoiceGross: "120.00", originalTax: [{ tax_rate: "20", tax_amount: "20.00" }] };
describe("advance VAT from immutable cash allocations", () => {
  it("books two receipts without duplicate bank money or lost cents", () => {
    const first = planAdvanceVat({ ...facts, allocationAmount: "80.00", prior: [] });
    const second = planAdvanceVat({ ...facts, allocationAmount: "40.00", prior: [first] });
    expect(first.entries[0].tax_amount).toBe("13.33");
    expect(second.entries[0].tax_amount).toBe("6.67");
    expect(second.tax_after).toBe("20.00");
  });
  it("keeps every category monotonic across many small mixed-rate receipts", () => {
    const mixed = { ...facts, invoiceGross: "12.70", originalTax: [{ tax_rate: "5.5", tax_amount: "0.33" }, { tax_rate: "20", tax_amount: "1.12" }, { tax_rate: "0", tax_amount: "0.00" }] };
    const prior: AdvanceVatSnapshot[] = [];
    for (let i = 0; i < 127; i++) prior.push(planAdvanceVat({ ...mixed, allocationAmount: "0.10", prior: [...prior].reverse() }));
    expect(prior.flatMap(s => s.entries).reduce((sum, e) => sum + moneyToCents(e.tax_amount), 0n)).toBe(145n);
    for (const original of mixed.originalTax) expect(prior.flatMap(s => s.entries).filter(e => Number(e.tax_rate) === Number(original.tax_rate))
      .reduce((sum, e) => sum + moneyToCents(e.tax_amount), 0n)).toBe(moneyToCents(original.tax_amount));
  });
  it("rejects altered facts, overlapping chains and overpayments", () => {
    const first = planAdvanceVat({ ...facts, allocationAmount: "80.00", prior: [] });
    expect(() => planAdvanceVat({ ...facts, allocationAmount: "40.01", prior: [first] })).toThrow();
    expect(() => planAdvanceVat({ ...facts, allocationAmount: "1.00", prior: [first, first] })).toThrow();
    expect(() => planAdvanceVat({ ...facts, allocationAmount: "1.00", prior: [{ ...first, invoice_sha256: "b".repeat(64) }] })).toThrow();
    expect(() => planAdvanceVat({ ...facts, allocationAmount: "1.00", prior: [{ ...first, entries: [{ tax_rate: "20", tax_amount: "13.34" }] }] })).toThrow();
  });
  it("retains a zero VAT cash fact without creating a zero-valued posting", () => {
    const s = planAdvanceVat({ ...facts, originalTax: [{ tax_rate: "0", tax_amount: "0.00" }], allocationAmount: "80.00", prior: [] });
    expect(s.tax_before).toBe("0.00"); expect(s.tax_after).toBe("0.00");
  });
});
