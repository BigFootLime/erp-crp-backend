import { describe, it, expect } from "vitest";
import { assertPromiseParts, measureDeliveryPromises } from "./delivery-promises";
describe("commercial promise quantities and punctuality", () => {
    it("preserves 100 pieces while advancing 20", () => { expect(() => assertPromiseParts([{ quantity: 20, due_date: "2026-10-10" }, { quantity: 80, due_date: "2026-10-20" }], 100)).not.toThrow(); });
    it("rejects a quantity change and impossible civil dates", () => { expect(() => assertPromiseParts([{ quantity: 99, due_date: "2026-10-20" }], 100)).toThrow(); expect(() => assertPromiseParts([{ quantity: 100, due_date: "2026-02-30" }], 100)).toThrow(); expect(() => assertPromiseParts([{ quantity: 100, due_date: "2026-99-99" }], 100)).toThrow(); });
    it("does not remove open overdue quantities from OTD", () => { const result = measureDeliveryPromises([{ quantity: 20, due_date: "2026-10-05", delivered_date: "2026-10-04" }, { quantity: 30, due_date: "2026-10-05", delivered_date: "2026-10-06" }, { quantity: 30, due_date: "2026-10-05", delivered_date: null }, { quantity: 20, due_date: "2026-10-20", delivered_date: null }], "2026-10-07"); expect(result).toEqual({ on_time: 20, late_delivered: 30, open_overdue: 30, pending: 20, assessed: 80, punctuality_percent: 25 }); });
    it("keeps the metric undefined until quantities can be evaluated", () => { expect(measureDeliveryPromises([{ quantity: 100, due_date: "2026-10-20", delivered_date: null }], "2026-10-07").punctuality_percent).toBeNull(); });
});
