import { describe, expect, it } from "vitest";
import {
  allocateReceivedQuantity,
  buildConsolidationPlan,
  type ConsolidationSource,
} from "./consolidation-rules";
function source(id: number, qty: number): ConsolidationSource {
  return {
    id,
    numero: `OF-${id}`,
    client_id: "ABC",
    article_id: "a",
    unit: "PCE",
    piece_technique_id: "p",
    piece_technique_version_id: "v2",
    technical_snapshot_sha256: "same",
    quantite_lancee: qty,
    quantite_bonne: 0,
    quantite_rebut: 0,
    statut: "BROUILLON",
    technical_readiness: "VALIDATED",
    planned_count: 0,
    started_count: 0,
    covered: false,
    producer: false,
    updated_at: "2026-09-05T10:00:00Z",
    planning_wait_started_at:
      id === 1 ? "2026-09-01T10:00:00Z" : "2026-09-04T10:00:00Z",
    date_fin_prevue: "2026-10-01",
    parent_of_id: id + 100,
    root_of_id: id + 100,
    technical_snapshot: {},
  };
}
describe("Production consolidation conservation", () => {
  it("combines already-net OF quantities and explicit surplus, without deducting stock twice", () => {
    const p = buildConsolidationPlan([source(1, 12.125), source(2, 8.875)], 4);
    expect(p.quantity).toBe(25);
    expect(p.demand_quantity).toBe(21);
    expect(p.planning_wait_started_at).toBe("2026-09-01T10:00:00Z");
    expect(p.allocations.map((a) => a.parent_of_id)).toEqual([101, 102]);
  });
  it("keeps yield-sized launch and material quantities separate from good allocations", () => {
    const pilot = (id: number): ConsolidationSource => ({
      ...source(id, 112),
      industrial_semantics: {
        coverage_semantics: "GOOD_OUTPUT_V1",
        launched_quantity: 112,
        required_good_quantity: 100,
        expected_good_quantity: 100,
        yield_percent: 90,
      },
    });
    const plan = buildConsolidationPlan([pilot(1), pilot(2)], 0);
    // 224 units are physically launched, but only 100+100 good pieces are
    // allocated to the two original commercial demands.
    expect(plan).toMatchObject({
      quantity: 224,
      demand_quantity: 200,
      surplus_quantity: 0,
    });
    expect(plan.allocations).toEqual([
      expect.objectContaining({
        source_of_id: 1,
        quantity: 100,
        launched_quantity: 112,
      }),
      expect.objectContaining({
        source_of_id: 2,
        quantity: 100,
        launched_quantity: 112,
      }),
    ]);
  });
  it("does not promise a pilot OF when its frozen yield token is invalid", () => {
    expect(() =>
      buildConsolidationPlan(
        [
          {
            ...source(1, 112),
            industrial_semantics: {
              coverage_semantics: "GOOD_OUTPUT_V1",
              launched_quantity: 112,
              required_good_quantity: 100,
              expected_good_quantity: 100,
              yield_percent: 0,
            },
          },
          source(2, 112),
        ],
        0,
      ),
    ).toThrow(/rendement figé/i);
  });
  it("refuses a pilot source whose frozen yield produces no good piece", () => {
    expect(() => buildConsolidationPlan([
      { ...source(1, 0.001), industrial_semantics: {
        coverage_semantics: "GOOD_OUTPUT_V1", launched_quantity: 1,
        required_good_quantity: 1, expected_good_quantity: 1, yield_percent: 1,
      } },
      source(2, 1),
    ], 0)).toThrow(/aucune pièce conforme/i);
  });
  it("projects the same frozen yield token after a manual gross change", () => {
    const pilot = (id: number, launched: number): ConsolidationSource => ({
      ...source(id, launched),
      industrial_semantics: {
        coverage_semantics: "GOOD_OUTPUT_V1",
        launched_quantity: 112,
        required_good_quantity: 100,
        expected_good_quantity: 100,
        yield_percent: 90,
      },
    });
    expect(
      buildConsolidationPlan([pilot(1, 120), source(2, 10)], 0).allocations[0],
    ).toMatchObject({ quantity: 100, launched_quantity: 120 });
    expect(
      buildConsolidationPlan([pilot(1, 100), source(2, 10)], 0).allocations[0],
    ).toMatchObject({ quantity: 90, launched_quantity: 100 });
    expect(
      buildConsolidationPlan([pilot(1, 85), source(2, 10)], 0).allocations[0],
    ).toMatchObject({ quantity: 76, launched_quantity: 85 });
  });
  it("uses millesimal floor for continuous units", () => {
    const pilot: ConsolidationSource = {
      ...source(1, 85.999),
      unit: "kg",
      industrial_semantics: {
        coverage_semantics: "GOOD_OUTPUT_V1",
        launched_quantity: 112,
        required_good_quantity: 100,
        expected_good_quantity: 100,
        yield_percent: 90,
      },
    };
    expect(
      buildConsolidationPlan([pilot, source(2, 1)], 0).allocations[0],
    ).toMatchObject({ quantity: 77.399 });
  });
  it.each([
    ["client_id", "DEF"],
    ["article_id", "other"],
    ["piece_technique_version_id", "v1"],
    ["technical_snapshot_sha256", "different"],
    ["statut", "PLANIFIE"],
    ["technical_readiness", "INCOMPLETE"],
    ["planned_count", 1],
    ["started_count", 1],
    ["quantite_bonne", 1],
    ["quantite_rebut", 1],
    ["covered", true],
    ["producer", true],
  ] as const)("rejects incompatibility or engagement: %s", (key, value) => {
    const s = { ...source(2, 10), [key]: value };
    expect(() => buildConsolidationPlan([source(1, 10), s], 0)).toThrow();
  });
  it("rejects duplicate sources", () =>
    expect(() =>
      buildConsolidationPlan([source(1, 10), source(1, 10)], 0),
    ).toThrow());
  it("allocates partial receipts by due date, preserving remaining needs", () => {
    expect(
      allocateReceivedQuantity(
        [
          {
            id: "b",
            quantity: 10,
            received_quantity: 0,
            due_date: "2026-10-02",
          },
          {
            id: "a",
            quantity: 10,
            received_quantity: 3,
            due_date: "2026-10-01",
          },
        ],
        12,
      ),
    ).toEqual({
      allocations: [
        { allocation_id: "a", quantity: 7 },
        { allocation_id: "b", quantity: 5 },
      ],
      surplus: 0,
    });
  });
  it("allocates only the good commercial shares; physical yield margin remains stock", () => {
    const distributed = allocateReceivedQuantity(
      [
        {
          id: "first",
          quantity: 100,
          received_quantity: 0,
          due_date: "2026-10-01",
        },
        {
          id: "second",
          quantity: 100,
          received_quantity: 0,
          due_date: "2026-10-02",
        },
      ],
      224,
    );
    expect(distributed.allocations).toEqual([
      { allocation_id: "first", quantity: 100 },
      { allocation_id: "second", quantity: 100 },
    ]);
    expect(distributed.surplus).toBe(24);
  });
  it("leaves only actual received excess in stock", () =>
    expect(
      allocateReceivedQuantity(
        [{ id: "a", quantity: 3, received_quantity: 2, due_date: null }],
        5,
      ),
    ).toEqual({
      allocations: [{ allocation_id: "a", quantity: 1 }],
      surplus: 4,
    }));
  it("handles fractional quantities without decimal drift", () =>
    expect(
      allocateReceivedQuantity(
        [{ id: "a", quantity: 0.3, received_quantity: 0.1, due_date: null }],
        0.2,
      ),
    ).toEqual({
      allocations: [{ allocation_id: "a", quantity: 0.2 }],
      surplus: 0,
    }));
});
