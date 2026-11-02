import { describe, it, expect } from "vitest";
import { calculateIndustrialPlan } from "./industrial-plan";
import type {
  IndustrialInput,
  IndustrialDemand,
  IndustrialArticle,
  IndustrialSource,
} from "../types/industrial-plan.types";

const article = (
  id: string,
  kind: IndustrialArticle["kind"] = "MAKE",
): IndustrialArticle => ({
  id,
  code: id,
  unit: "PCE",
  family: "Assises",
  kind,
  leadDays: 2,
  lot: null,
  cost: "10",
  yieldPercent: "100",
  minStock: "0",
  targetStock: "0",
  technicalIssues: [],
});
const demand = (
  id: string,
  quantity: string,
  kind: IndustrialDemand["kind"] = "FIRM",
): IndustrialDemand => ({
  id,
  article: "ASSEMBLY",
  unit: "PCE",
  contractLine: "contract",
  orderLine: id,
  allocation: null,
  kind,
  quantity,
  due: "2027-01-25",
  priceEur: "12",
});
const supply = (id: string, quantity: string): IndustrialSource => ({
  id,
  article: "ASSEMBLY",
  unit: "PCE",
  quantity,
  available: "2027-01-04",
  orderLine: null,
  allocation: null,
  contractLine: null,
  kind: "STOCK",
});
function source(): IndustrialInput {
  const from = Date.parse("2027-01-04T12:00:00Z");
  return {
    start: "2027-01-04",
    today: "2027-01-04",
    months: 18,
    weeks: 26,
    frozenDays: 14,
    clientId: "PILOT",
    clientRisk: "1000",
    openingExposure: "0",
    articles: [article("ASSEMBLY")],
    bom: [],
    demand: [],
    supplies: [],
    rules: [
      {
        id: "contract",
        clientId: "PILOT",
        article: "ASSEMBLY",
        reserve: "0",
        target: "0",
        forecastCommitted: false,
        riskEur: "1000",
      },
    ],
    workdays: Array.from(
      { length: 400 },
      (_, i) => new Date(from + i * 86400000),
    )
      .filter((d) => d.getUTCDay() > 0 && d.getUTCDay() < 6)
      .map((d) => d.toISOString().slice(0, 10)),
    issues: [],
  };
}
describe("Industrial PIC/PDP/CBN", () => {
  it("uses piece aliases across the order, stock and manufacturing article", () => {
    const input = source();
    input.articles[0].unit = "U";
    input.articles[0].yieldPercent = "90";
    input.demand = [{ ...demand("firm", "110"), contractLine: null, unit: "PCE" }];
    input.supplies = [{ ...supply("stock", "10"), unit: "pièces" }];
    expect(calculateIndustrialPlan(input).proposals[0]).toMatchObject({
      quantity: 112, required_good_quantity: 100, expected_good_quantity: 100,
    });
  });
  it("grosses up only the net good pieces, rounds to whole starts and sizes components from the gross OF", () => {
    const input = source();
    input.articles[0].yieldPercent = "90";
    input.articles.push(article("BLANK", "BUY"));
    input.bom = [{ parent: "ASSEMBLY", child: "BLANK", factor: "2" }];
    input.demand = [demand("line", "110")];
    input.supplies = [supply("reserved-good", "10")];
    const result = calculateIndustrialPlan(input);
    expect(result.proposals[0]).toMatchObject({
      quantity: 112, required_good_quantity: 100, expected_good_quantity: 100, yield_percent: 90,
    });
    expect(result.proposals[1]).toMatchObject({ article: "BLANK", quantity: 224 });
    expect(result.pdp.filter(cell => cell.article === "ASSEMBLY" && cell.planned > 0)).toEqual([
      expect.objectContaining({ firm: 110, planned: 100, projected_stock: 0 }),
    ]);
  });

  it("charges the same rounded launch to the forecast risk limit as to the actual proposal", () => {
    const input = source();
    input.articles[0].yieldPercent = "80";
    input.articles[0].lot = "10";
    input.demand = [demand("forecast", "100", "FORECAST")];
    input.clientRisk = "1300";
    input.rules[0].riskEur = "1300";
    const result = calculateIndustrialPlan(input);
    expect(result.proposals[0]).toMatchObject({ quantity: 130, expected_good_quantity: 104, required_good_quantity: 100 });
    expect(result.forecast_exposure_eur).toBe(1300);
    input.clientRisk = "1299";
    expect(calculateIndustrialPlan(input).proposals).toEqual([]);
  });

  it("retains stock cover and the uncovered demand when a manufactured reference has no qualified yield", () => {
    const input = source();
    input.articles[0].yieldPercent = null;
    input.demand = [demand("line", "5")];
    input.supplies = [supply("available", "2")];
    const result = calculateIndustrialPlan(input);
    expect(result.proposals).toEqual([]);
    expect(result.allocations).toEqual([{ demand_id: "line", source_id: "available", quantity: 2 }]);
    expect(result.pdp.some(row => row.firm === 5 && row.shortage === 3)).toBe(true);
    expect(result.issues).toContain("ASSEMBLY : Rendement à qualifier avant de calculer le lancement.");
    input.demand = [demand("forecast", "5", "FORECAST")];
    expect(calculateIndustrialPlan(input).forecast_exposure_eur).toBe(0);
    input.articles[0].yieldPercent = "100";
    input.demand = [demand("line", "5")];
    expect(calculateIndustrialPlan(input).proposals[0]).toMatchObject({ quantity: 3, expected_good_quantity: 3 });
  });

  it("retains fractional units of manufacture at the supported OF precision", () => {
    const input = source();
    input.articles[0].unit = "KG";
    input.articles[0].yieldPercent = "90";
    input.demand = [{ ...demand("weighed", "1"), unit: "KG" }];
    expect(calculateIndustrialPlan(input).proposals[0]).toMatchObject({ quantity: 1.112, expected_good_quantity: 1 });
  });

  it("preserves months and weeks, consumes residual forecast only once, and never double-spends a physical source", () => {
    const input = source();
    input.demand = [
      demand("firm", "40"),
      demand("already-residual", "60", "FORECAST"),
    ];
    input.supplies = [supply("lot", "75")];
    const result = calculateIndustrialPlan(input);
    expect(result.pdp).toHaveLength(26);
    expect(result.pic).toHaveLength(18);
    expect(result.proposals.map((r) => r.quantity)).toEqual([25]);
    expect(result.allocations.reduce((n, r) => n + r.quantity, 0)).toBe(75);
    expect(result.pic[0]).toMatchObject({
      firm: 40,
      forecast: 60,
      authorized_forecast: 60,
      planned: 25,
      projected_stock: 0,
    });
  });
  it("explodes only new parent starts through both BOM levels and rounds shared net shortages to the purchase lot", () => {
    const input = source();
    input.articles.push(article("SUB"), {
      ...article("BOLT", "BUY"),
      lot: "10",
    });
    input.bom = [
      { parent: "ASSEMBLY", child: "SUB", factor: "2" },
      { parent: "SUB", child: "BOLT", factor: "3" },
    ];
    input.demand = [demand("firm", "10")];
    input.supplies = [
      supply("ready-assembly", "4"),
      {
        ...supply("open-oa", "8"),
        article: "BOLT",
        kind: "OA",
        available: "2027-01-05",
      },
    ];
    const result = calculateIndustrialPlan(input);
    expect(
      result.proposals.map((p) => [p.article, p.quantity, p.due, p.release]),
    ).toEqual([
      ["ASSEMBLY", 6, "2027-01-25", "2027-01-21"],
      ["SUB", 12, "2027-01-21", "2027-01-19"],
      ["BOLT", 30, "2027-01-19", "2027-01-15"],
    ]);
    expect(result.proposals[2].source_ids).toEqual(["firm"]);
  });
  it("blocks uncovered uncommitted forecasts if exposure is unknown or the rounded lot exceeds the ceiling", () => {
    const input = source();
    input.clientRisk = "35";
    input.articles[0].lot = "10";
    input.demand = [demand("estimate", "20", "FORECAST")];
    for (const exposure of ["0", null]) {
      input.openingExposure = exposure;
      const r = calculateIndustrialPlan(input);
      expect(r.proposals).toEqual([]);
      expect(r.pic[0]).toMatchObject({
        forecast: 20,
        authorized_forecast: 0,
        shortage: 20,
      });
    }
  });
  it("protects quantities dedicated to another contract when an earlier firm arrives", () => {
    const input = source();
    input.rules[0].reserve = "10";
    input.rules[0].target = "10";
    input.supplies = [supply("stock", "12")];
    input.demand = [
      { ...demand("outside", "5"), contractLine: null },
      demand("inside", "10"),
    ];
    const r = calculateIndustrialPlan(input);
    expect(
      r.proposals.some(
        (p) => p.source_ids.includes("outside") && p.quantity === 3,
      ),
    ).toBe(true);
    expect(
      r.allocations
        .filter((a) => a.demand_id === "outside")
        .reduce((n, a) => n + a.quantity, 0),
    ).toBe(2);
  });
  it("rejects a BOM cycle and duplicate physical supplies", () => {
    const input = source();
    input.bom = [{ parent: "ASSEMBLY", child: "ASSEMBLY", factor: "1" }];
    expect(() => calculateIndustrialPlan(input)).toThrow("Cycle");
    input.bom = [];
    input.supplies = [supply("same", "20"), supply("same", "20")];
    expect(() => calculateIndustrialPlan(input)).toThrow("dupliquée");
  });
});
