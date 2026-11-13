import { describe, expect, it } from "vitest";
import { classifySupplierPromiseExceptions } from "./supplier-promise-exceptions";

const row = (overrides = {}) => ({
  id: "line-1",
  orderCode: "PO-1",
  supplierName: "Traitement",
  status: "ACCUSE_RECU",
  promisedDate: "2026-11-05",
  needDate: "2026-11-02",
  ordered: 100,
  received: 0,
  isSubcontract: true,
  ofId: 7,
  customerOrderId: 9,
  ...overrides,
});

describe("classifySupplierPromiseExceptions", () => {
  it("reports an unacknowledged sent purchase without pretending it has a delivery date", () => {
    const [issue] = classifySupplierPromiseExceptions(
      [row({ status: "ENVOYEE", promisedDate: null })],
      "2026-11-01",
    );
    expect(issue).toMatchObject({
      code: "MISSING_ACKNOWLEDGEMENT",
      severity: "P1",
      remaining: 100,
      impacts: ["SUBCONTRACT", "WORK_ORDER", "CUSTOMER_ORDER"],
    });
  });
  it("elevates a remaining overdue supplier promise", () => {
    const [issue] = classifySupplierPromiseExceptions(
      [row({ promisedDate: "2026-10-31", received: 25 })],
      "2026-11-01",
    );
    expect(issue).toMatchObject({
      code: "PROMISE_OVERDUE",
      severity: "P0",
      remaining: 75,
    });
  });
  it("does not surface a fully received purchase", () => {
    expect(
      classifySupplierPromiseExceptions(
        [row({ received: 100, promisedDate: null })],
        "2026-11-01",
      ),
    ).toEqual([]);
  });
});
