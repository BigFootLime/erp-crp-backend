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
