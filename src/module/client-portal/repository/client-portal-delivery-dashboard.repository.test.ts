import { describe, expect, it, vi } from "vitest";

vi.mock("../../../config/database", () => ({ default: { query: vi.fn() } }));

import { projectPortalDeliveryServiceKpis } from "./client-portal-delivery-dashboard.repository";

describe("portal delivery service KPI projection", () => {
  it("uses immutable shipment promise evidence and keeps an incomplete receipt out of the arrival rate", () => {
    const result = projectPortalDeliveryServiceKpis([
      {
        bl_id: "bl-1",
        bl_allocation_id: "a-1",
        bl_line_id: "l-1",
        shipment_quantity: "10",
        initial_due_date: "2026-10-10",
        due_date_at_shipment: "2026-10-12",
        departure_due_date_at_shipment: "2026-10-09",
        date_expedition: "2026-10-09",
        receipt_quantity: "10",
        receipt_completed_at: "2026-10-11T10:00:00Z",
        receipt_mapping_is_unambiguous: true,
      },
      {
        bl_id: "bl-2",
        bl_allocation_id: "a-2",
        bl_line_id: "l-2",
        shipment_quantity: "5",
        initial_due_date: "2026-10-10",
        due_date_at_shipment: "2026-10-12",
        departure_due_date_at_shipment: null,
        date_expedition: "2026-10-09",
        receipt_quantity: "2",
        receipt_completed_at: null,
        receipt_mapping_is_unambiguous: true,
      },
      {
        bl_id: "bl-3",
        bl_allocation_id: "a-3",
        bl_line_id: "l-3",
        shipment_quantity: "3",
        initial_due_date: "2026-10-10",
        due_date_at_shipment: "2026-10-12",
        departure_due_date_at_shipment: null,
        date_expedition: "2026-10-09",
        receipt_quantity: "3",
        receipt_completed_at: "2026-10-09T10:00:00Z",
        receipt_mapping_is_unambiguous: false,
      },
    ]);
    expect(result.dispatch.initial).toMatchObject({
      promised_quantity: 10,
      on_time_quantity: 10,
      rate: 1,
    });
    expect(result.arrival.initial).toMatchObject({
      promised_quantity: 18,
      receipt_evidence_quantity: 10,
      on_time_quantity: 0,
      rate: 0,
    });
    expect(result.arrival.last_agreed_at_shipment).toMatchObject({
      receipt_evidence_quantity: 10,
      on_time_quantity: 10,
      rate: 1,
    });
    expect(result.receipt_evidence).toMatchObject({
      shipped_quantity: 18,
      confirmed_quantity: 10,
      missing_quantity: 8,
      ambiguous_allocation_quantity: 3,
    });
  });
});
