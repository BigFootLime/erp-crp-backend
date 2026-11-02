import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import type { DemandRow } from "../types/demand-pilot.types";
import type { IndustrialDemand } from "../../planning/types/industrial-plan.types";
import { scenarioInput } from "./demand-scenario-input";

const row = {
  id: "request",
  client_id: "QA",
  external_site: "site",
  external_order_key: "A",
  external_line_key: "1",
  external_schedule_key: "S1",
  article_id: "part",
  revision_no: 2,
  kind: "FIRM",
  quantity: "40",
  quantity_basis: "REMAINING",
  diff_type: "CHANGED",
} as DemandRow;
function tx(bound: unknown[], forecast: unknown[]) {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: bound })
      .mockResolvedValueOnce({ rows: forecast }),
  } as unknown as PoolClient;
}
const book = (
  id: string,
  qty: string,
  allocation: string | null = null,
): IndustrialDemand => ({
  id,
  article: "part",
  unit: "PCE",
  quantity: qty,
  orderLine: allocation ? "line" : null,
  allocation,
  contractLine: null,
  kind: allocation ? "FIRM" : "FORECAST",
  due: "2030-01-09",
  priceEur: null,
});
describe("Simulation of a revised commercial schedule", () => {
  it("keeps the residual already reduced by the native forecast conversion", async () => {
    const result = await scenarioInput(
      tx(
        [],
        [
          {
            id: "previous",
            forecast_id: "f",
            converted: "40",
            draft_lines: ["draft"],
          },
        ],
      ),
      row,
      [book("forecast:f:previous", "60")],
    );
    expect(result.retained[0].quantity).toBe("60");
    expect(result.quantity).toBe("40");
  });
  it("consumes only the converted part of an identified forecast", async () => {
    const input = [book("forecast:f:previous", "100"), book("another", "20")];
    const result = await scenarioInput(
      tx([], [{ id: "previous", forecast_id: "f" }]),
      row,
      input,
    );
    expect(result.retained.map((d) => d.quantity)).toEqual(["60", "20"]);
    expect(result.quantity).toBe("40");
    expect(input[0].quantity).toBe("100");
  });
  it("replaces only the linked delivery and subtracts shipments only from totals", async () => {
    const bound = {
      line: "line",
      allocation: "1",
      shipped: "4",
      article: "part",
    };
    const input = [book("firm:1", "46", "1"), book("firm:2", "25", "2")];
    for (const [basis, qty] of [
      ["TOTAL", "36"],
      ["REMAINING", "40"],
    ] as const) {
      const result = await scenarioInput(
        tx([bound], []),
        { ...row, quantity_basis: basis },
        input,
      );
      expect(result.quantity).toBe(qty);
      expect(result.retained.map((d) => d.id)).toEqual(["firm:2"]);
    }
  });
});
