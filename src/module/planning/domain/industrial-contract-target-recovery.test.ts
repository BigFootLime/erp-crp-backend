import { describe, expect, it } from "vitest";
import { proposeIndustrialContractTargetRecovery } from "./industrial-contract-target-recovery";
import type { IndustrialInput, IndustrialResult } from "../types/industrial-plan.types";

const source = (): IndustrialInput => ({
  start: "2026-10-01",
  today: "2026-10-01",
  months: 18,
  weeks: 26,
  frozenDays: 14,
  clientId: "VISION",
  clientRisk: "1000",
  openingExposure: "0",
  articles: [{id:"vision-part",code:"VS-PART",unit:"PCE",family:"Pilote",kind:"MAKE",leadDays:2,
    lot:"1",cost:"5",yieldPercent:"100",minStock:"0",targetStock:"0",technicalIssues:[]}],
  bom: [],
  demand: [{
    id: "firm-s44",
    article: "vision-part",
    unit: "PCE",
    contractLine: "vision-contract-line",
    orderLine: "order-line",
    allocation: null,
    kind: "FIRM",
    quantity: "12",
    due: "2026-10-24",
    priceEur: "10",
  }],
  supplies: [
    { id: "stock-reserve", article: "vision-part", unit: "PCE", quantity: "3", available: "2026-10-01", orderLine: null, allocation: null, contractLine: "vision-contract-line", kind: "STOCK" },
    { id: "open-of", article: "vision-part", unit: "PCE", quantity: "2", available: "2026-10-20", orderLine: null, allocation: null, contractLine: "vision-contract-line", kind: "OF" },
  ],
  rules: [],
  workdays: [],
  issues: [],
});

const result = (): IndustrialResult => ({
  pic: [],
  pdp: [],
  proposals: [
    {
      article_id: "vision-part",
      article: "VS-PART",
      unit: "PCE",
      kind: "MAKE",
      quantity: 7,
      due: "2026-10-24",
      release: "2026-10-16",
      source_ids: ["firm-s44"],
      issues: [],
      contract_line_id: "vision-contract-line",
    },
    // Same source on a BOM child must not duplicate the customer recovery.
    {
      article_id: "component",
      article: "VS-COMP",
      unit: "PCE",
      kind: "BUY",
      quantity: 7,
      due: "2026-10-16",
      release: "2026-10-14",
      source_ids: ["firm-s44"],
      issues: [],
      contract_line_id: null,
    },
  ],
  allocations: [
    { demand_id: "firm-s44", source_id: "stock-reserve", quantity: 3 },
    { demand_id: "firm-s44", source_id: "open-of", quantity: 2 },
  ],
  issues: [],
  forecast_exposure_eur: 0,
});

const prepared = [{
  contract_line_id: "vision-contract-line",
  article_id: "vision-part",
  article: "VS-PART",
  unit: "PCE",
  month: "2026-09",
  target_date: "2026-09-30",
  target_overdue: true,
  proposed_quantity: 12,
}];

describe("overdue Vision contract target recovery", () => {
  it("keeps firm schedules separate and escalates an open unconfirmed order or a lot surplus", () => {
    const data = source(), net = result();
    data.demand.push({...data.demand[0],id:"firm-next",quantity:"2",due:"2026-10-27"});
    net.proposals.push({...net.proposals[0],source_ids:["firm-next"],quantity:5,due:"2026-10-27"});
    const projections = proposeIndustrialContractTargetRecovery({
      source:data,result:net,prepared:[...prepared,{...prepared[0],target_date:"2026-08-31"}],placements:[],
      commitments:[{source:"production:17",article:"vision-part",reference:"OF-TEST",order_line:"order-line",contract_line:"vision-contract-line"}],
    });
    expect(projections).toHaveLength(2);
    expect(projections.map(p=>p.proposed_quantity)).toEqual([7,2]);
    expect(projections.every(p=>p.status==="ARBITRATION_REQUIRED" && p.risks.some(r=>r.includes("OF-TEST")))).toBe(true);
    expect(projections[1].risks.some(r=>r.includes("surplus"))).toBe(true);
  });
  it("makes one S44 proposal only when the net PDP shortage has a safe finite-capacity slot", () => {
    const out = proposeIndustrialContractTargetRecovery({
      source: source(),
      result: result(),
      prepared,
      placements: [{
        article_id: "vision-part",
        source_ids: ["firm-s44"],
        requested: "2026-10-24",
        projected_finish: "2026-10-22T16:00:00.000Z",
        blockers: [],
        status: "CAPACITY_SIMULATED",
      }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      mode: "PROPOSAL_ONLY",
      target_month: "2026-09",
      need_date: "2026-10-24",
      quantity_needed: 12,
      reserved_quantity: 3,
      open_supply_quantity: 2,
      proposed_quantity: 7,
      earliest_safe_date: "2026-10-22",
      frozen_until: "2026-10-15",
      status: "PROPOSED",
    });
  });

  it("requires arbitration rather than moving a frozen or late commitment", () => {
    const input = {
      source: source(),
      result: result(),
      prepared,
      placements: [{
        article_id: "vision-part",
        source_ids: ["firm-s44"],
        requested: "2026-10-24",
        projected_finish: "2026-10-28T16:00:00.000Z",
        blockers: ["Usinage : aucun créneau qualifié."],
        status: "REVIEW",
      }],
    };
    const first = proposeIndustrialContractTargetRecovery(input);
    const second = proposeIndustrialContractTargetRecovery(input);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      status: "ARBITRATION_REQUIRED",
      earliest_safe_date: null,
      proposed_quantity: 7,
    });
    expect(first[0].risks).toEqual(expect.arrayContaining([
      "Le premier créneau sûr dépasse la date ferme du client.",
      "Usinage : aucun créneau qualifié.",
    ]));
  });
});
