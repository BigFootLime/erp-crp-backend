import { describe, expect, it } from "vitest";
import { customerInvoiceBalance } from "./customer-balance";

describe("paid invoice credit and refund balance", () => {
  it("keeps a fully paid invoice refundable after a partial credit", () => {
    expect(customerInvoiceBalance({ gross: 12000n, cash: 12000n, credits: 6000n, refunds: 0n }))
      .toEqual({ settled: 18000n, due: 0n, refundable: 6000n, creditsRemaining: 6000n, netCash: 12000n });
  });
  it("uses the unpaid balance first and only refunds actual excess cash", () => {
    expect(customerInvoiceBalance({ gross: 12000n, cash: 8000n, credits: 6000n, refunds: 0n }).refundable).toBe(2000n);
    const closed = customerInvoiceBalance({ gross: 12000n, cash: 8000n, credits: 6000n, refunds: 2000n });
    expect(closed.refundable).toBe(0n); expect(closed.due).toBe(0n);
    expect(customerInvoiceBalance({ gross: 12000n, cash: 2000n, credits: 6000n, refunds: 0n }).due).toBe(4000n);
  });
  it("allows complete correction of a paid invoice without inventing a second payment", () => {
    const refunded = customerInvoiceBalance({ gross: 12000n, cash: 12000n, credits: 12000n, refunds: 12000n });
    expect(refunded.netCash).toBe(0n); expect(refunded.refundable).toBe(0n); expect(refunded.due).toBe(0n);
  });
  it.each([
    { gross: 12000n, cash: 12000n, credits: 12001n, refunds: 0n },
    { gross: 12000n, cash: 8000n, credits: 6000n, refunds: 6001n },
    { gross: 12000n, cash: 12001n, credits: 0n, refunds: 0n },
    { gross: 12000n, cash: 2000n, credits: 6000n, refunds: 2001n },
  ])("refuses incoherent or duplicated balances", args => {
    expect(() => customerInvoiceBalance(args)).toThrow();
  });
});
