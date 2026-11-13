import { describe, expect, it } from "vitest";
import { portalDeliveryReceiptSchema } from "./client-portal.validators";

describe("portal delivery receipt input", () => {
  it("accepts a partial receipt with an immutable delivery timestamp", () => {
    expect(
      portalDeliveryReceiptSchema.parse({
        delivered_at: "2026-10-31T10:00:00.000Z",
        line_receipts: [
          {
            delivery_line_id: "11111111-1111-4111-8111-111111111111",
            quantity_received: 1.5,
          },
        ],
      }).line_receipts,
    ).toHaveLength(1);
  });
  it("refuses a receipt without a positive line quantity", () => {
    expect(
      portalDeliveryReceiptSchema.safeParse({
        delivered_at: "2026-10-31T10:00:00.000Z",
        line_receipts: [
          {
            delivery_line_id: "11111111-1111-4111-8111-111111111111",
            quantity_received: 0,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("refuses duplicate delivery lines so an idempotent receipt cannot double count one line", () => {
    expect(
      portalDeliveryReceiptSchema.safeParse({
        delivered_at: "2026-10-31T10:00:00.000Z",
        line_receipts: [
          {
            delivery_line_id: "11111111-1111-4111-8111-111111111111",
            quantity_received: 1,
          },
          {
            delivery_line_id: "11111111-1111-4111-8111-111111111111",
            quantity_received: 1,
          },
        ],
      }).success,
    ).toBe(false);
  });
});
