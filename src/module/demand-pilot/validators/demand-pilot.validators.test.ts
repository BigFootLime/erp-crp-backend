import { describe, expect, it } from "vitest";
import {
  demandRowSchema,
  portalResponseSchema,
} from "./demand-pilot.validators";

describe("demand-pilot request validation", () => {
  it("requires every part of the external schedule identity", () => {
    const parsed = demandRowSchema.safeParse({
      external_site: "VS-01",
      external_order_key: "PO-1",
      external_line_key: "10",
      source_version: "2026-10-31T12:00:00Z",
      source_as_of: "2026-10-31T12:00:00Z",
      kind: "FIRM",
      quantity: 12,
      need_date: "2026-11-15",
    });
    expect(parsed.success).toBe(false);
  });

  it("keeps the source quantity semantics explicit and defaults ordinary exports to TOTAL", () => {
    const base = {
      external_site: "VS-01",
      external_order_key: "PO-1",
      external_line_key: "10",
      external_schedule_key: "20",
      source_version: "v1",
      source_as_of: "2026-10-31T12:00:00Z",
      kind: "FIRM",
      quantity: 12,
      unit: "PCE",
      need_date: "2026-11-15",
      article_code: "A-1",
      article_id: "11111111-1111-4111-8111-111111111111",
    };
    expect(demandRowSchema.parse(base).quantity_basis).toBe("TOTAL");
    expect(
      demandRowSchema.parse({ ...base, quantity_basis: "REMAINING" })
        .quantity_basis,
    ).toBe("REMAINING");
    expect(demandRowSchema.safeParse({ ...base, unit: "" }).success).toBe(
      false,
    );
  });

  it("requires a date for a portal counterproposal", () => {
    expect(
      portalResponseSchema.safeParse({
        expected_version: 1,
        response: "COUNTERPROPOSE",
      }).success,
    ).toBe(false);
    expect(
      portalResponseSchema.safeParse({
        expected_version: 1,
        response: "COUNTERPROPOSE",
        proposed_need_date: "2026-11-15",
      }).success,
    ).toBe(true);
  });
});
