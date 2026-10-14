import { describe, expect, it } from "vitest";
import { planAdjustedAdvanceVat } from "./adjusted-advance-vat";
import { planAdvanceVat } from "./advance-vat";
import { planAdvanceCreditVat } from "./advance-credit-vat";

const facts = { invoiceId: 1, invoiceSha256: "a".repeat(64), invoiceGross: "120.00", originalTax: [{ tax_rate: "20", tax_amount: "20.00" }] };
const original = [{ tax_rate: "20", amount_ex_tax: "100.00", tax_amount: "20.00" }];
const halfCredit = (collected: string) => planAdvanceCreditVat({ ...facts, original, collected: new Map([["20.0000", collected]]),
  cleared: new Map(), prior: [], credit: [{ tax_rate: "20", amount_ex_tax: "50.00", tax_amount: "10.00" }] });

describe("cash received after a qualified advance credit", () => {
  it("takes the remaining debt in two receipts, recognizing the retained VAT once", () => {
    const credits = [halfCredit("0.00")];
    const first = planAdjustedAdvanceVat({ ...facts, allocationAmount: "40.00", prior: [], credits, refundedGross: "0.00" });
    const last = planAdjustedAdvanceVat({ ...facts, allocationAmount: "20.00", prior: [first], credits, refundedGross: "0.00" });
    expect(first.version).toBe(2); expect(first.entries[0].tax_amount).toBe("6.67");
    expect(last.entries[0].tax_amount).toBe("3.33"); expect(last.tax_after).toBe("10.00");
    expect(last.adjustment?.due_before).toBe("20.00");
  });
  it("keeps a previous receipt intact and applies the credit only to pending VAT", () => {
    const prior = [planAdvanceVat({ ...facts, allocationAmount: "20.00", prior: [] })], credits = [halfCredit("3.33")];
    const result = planAdjustedAdvanceVat({ ...facts, allocationAmount: "40.00", prior, credits, refundedGross: "0.00" });
    expect(result.tax_before).toBe("3.33"); expect(result.entries[0].tax_amount).toBe("6.67");
    expect(prior[0].entries[0].tax_amount).toBe("3.33");
  });
  it("does not reopen the debt when a paid credit is refunded", () => {
    const prior = [planAdvanceVat({ ...facts, allocationAmount: "80.00", prior: [] })], credits = [halfCredit("13.33")];
    expect(() => planAdjustedAdvanceVat({ ...facts, allocationAmount: "0.01", prior, credits, refundedGross: "20.00" })).toThrow();
    expect(() => planAdjustedAdvanceVat({ ...facts, allocationAmount: "0.01", prior, credits, refundedGross: "20.01" })).toThrow();
  });
  it("rejects overlapping cash chains, stale credit bases and excessive receipts", () => {
    const credits = [halfCredit("0.00")], first = planAdjustedAdvanceVat({ ...facts, allocationAmount: "40.00", prior: [], credits, refundedGross: "0.00" });
    expect(() => planAdjustedAdvanceVat({ ...facts, allocationAmount: "20.01", prior: [first], credits, refundedGross: "0.00" })).toThrow();
    expect(() => planAdjustedAdvanceVat({ ...facts, allocationAmount: "1.00", prior: [first, first], credits, refundedGross: "0.00" })).toThrow();
    expect(() => planAdjustedAdvanceVat({ ...facts, allocationAmount: "1.00", prior: [{ ...first, adjustment: { ...first.adjustment!, credited_pending_tax: "9.00" } }], credits, refundedGross: "0.00" })).toThrow();
  });
  it("preserves exact category totals after a credit and many small mixed-rate receipts", () => {
    const mixed = { ...facts, invoiceGross: "13.05", originalTax: [{ tax_rate: "5.5", tax_amount: "0.33" }, { tax_rate: "20", tax_amount: "1.12" }] };
    const credit = planAdvanceCreditVat({ ...mixed, original: [{ tax_rate: "5.5", amount_ex_tax: "6.00", tax_amount: "0.33" }, { tax_rate: "20", amount_ex_tax: "5.60", tax_amount: "1.12" }],
      collected: new Map(), cleared: new Map(), prior: [], credit: [{ tax_rate: "5.5", amount_ex_tax: "3.00", tax_amount: "0.17" }, { tax_rate: "20", amount_ex_tax: "2.80", tax_amount: "0.56" }] });
    const prior: ReturnType<typeof planAdjustedAdvanceVat>[] = [];
    for (let i = 0; i < 65; i++) prior.push(planAdjustedAdvanceVat({ ...mixed, allocationAmount: "0.10", prior: [...prior].reverse(), credits: [credit], refundedGross: "0.00" }));
    prior.push(planAdjustedAdvanceVat({ ...mixed, allocationAmount: "0.02", prior, credits: [credit], refundedGross: "0.00" }));
    expect(prior.at(-1)?.tax_after).toBe("0.72");
    expect(prior.flatMap(item => item.entries).filter(item => item.tax_rate === "5.5000").reduce((sum, item) => sum + Math.round(Number(item.tax_amount) * 100), 0)).toBe(16);
    expect(prior.flatMap(item => item.entries).filter(item => item.tax_rate === "20.0000").reduce((sum, item) => sum + Math.round(Number(item.tax_amount) * 100), 0)).toBe(56);
  });
});
