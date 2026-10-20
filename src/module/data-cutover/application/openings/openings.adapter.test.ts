import { describe, expect, it } from "vitest";
import { openingApplicationAdapters } from "./openings.adapter";
import type { ApplicationContext } from "../application.types";
import type { CutoverRow } from "../../types/data-cutover.types";

const stock: CutoverRow = { id: "row", batch_id: "batch", domain: "OPENING_STOCK", legacy_key: "legacy", source_id: "source", sheet: "Stock", row_number: 2,
  source_values: {}, values: { stockScope: "OLD", stockKind: "MP", quantityCounted: "2", unit: "kg", warehouse: "MAG", location: "A1", qualityStatus: "LIBERE", owner: "CRP", lotReference: "LOT", countEvidence: "count" }, source_issues: [], decision: "INCLUDE", review_note: "ok", version: 1, status: "READY", issues: [] };
const context = (targets = new Map()): ApplicationContext => ({ client: { query: async () => { throw new Error("inspect must not write"); } } as never, batchId: "batch", actorId: 1, sourceSystem: "CLIPPER_EXCEL", correlationId: "preview", operationKey: "op", rows: [stock], targets });

describe("opening application adapters", () => {
  it("reports precise preview blockers without calling a writer", async () => {
    const adapter = openingApplicationAdapters.find((item) => item.kind === "OPENING_STOCK")!;
    await expect(adapter.inspect(context())).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "CUTOVER_STOCK_ARTICLE_UNRESOLVED" }),
    ]));
  });
  it("accepts an unambiguous resolved article in preview", async () => {
    const adapter = openingApplicationAdapters.find((item) => item.kind === "OPENING_STOCK")!;
    await expect(adapter.inspect(context(new Map([["ARTICLE:legacy", { id: "article", reference: null, type: "ARTICLE" }]])))).resolves.toEqual([]);
  });
  it("accepts optional blank reservations and equivalent decimal zero without a false blocker", async () => {
    const adapter = openingApplicationAdapters.find((item) => item.kind === "OPENING_STOCK")!;
    for (const quantityReserved of [null, "", "0.000", "00,00"]) {
      const fixture = context(new Map([["ARTICLE:legacy", { id: "article", reference: null, type: "ARTICLE" }]]));
      fixture.rows = [{ ...stock, values: { ...stock.values, quantityReserved } }];
      await expect(adapter.inspect(fixture)).resolves.toEqual([]);
    }
  });
  it("blocks an empty opening lot and an overlong native location during preview", async () => {
    const adapter = openingApplicationAdapters.find((item) => item.kind === "OPENING_STOCK")!;
    for (const [values, code] of [[{ quantityCounted: "0" }, "CUTOVER_STOCK_QUANTITY_REQUIRED"], [{ warehouse: "W".repeat(100), location: "L".repeat(100) }, "CUTOVER_STOCK_LOCATION_TOO_LONG"]] as const) {
      const fixture = context(new Map([["ARTICLE:legacy", { id: "article", reference: null, type: "ARTICLE" }]]));
      fixture.rows = [{ ...stock, values: { ...stock.values, ...values } }];
      await expect(adapter.inspect(fixture)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
    }
  });
  it("blocks a finished OLD lot whose plan and external revision do not resolve to one native version", async () => {
    const adapter = openingApplicationAdapters.find((item) => item.kind === "OPENING_STOCK")!;
    const fixture = context(new Map([
      ["ARTICLE:legacy", { id: "article", reference: null, type: "ARTICLE" }],
      ["CUSTOMER:CLI", { id: "001", reference: "CLI", type: "CUSTOMER" }],
    ]));
    fixture.client = { query: async () => ({ rows: [] }) } as never;
    fixture.rows = [{ ...stock, values: { ...stock.values, stockKind: "PF", customerCode: "CLI", planReference: "PLAN-42", externalRevision: "B" } }];
    await expect(adapter.inspect(fixture)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "CUTOVER_STOCK_PF_VERSION_UNRESOLVED" }),
    ]));
  });
});
