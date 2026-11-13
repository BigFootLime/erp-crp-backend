import { describe, expect, it } from "vitest";
import type { IndustrialProposal } from "../types/industrial-plan.types";
import { industrialProposalSnapshot } from "./industrial-proposal-execution.service";

const proposal = {
  article_id: "article",
  article: "Article",
  unit: "PCE",
  kind: "MAKE",
  quantity: 130,
  due: "2026-11-10",
  release: "2026-11-05",
  source_ids: ["firm:line::default"],
  issues: [],
  contract_line_id: null,
} satisfies IndustrialProposal;

describe("industrial proposal execution evidence", () => {
  it("persists the good-output semantics from a yield-qualified proposal", () => {
    expect(
      industrialProposalSnapshot({
        ...proposal,
        required_good_quantity: 100,
        expected_good_quantity: 104,
        yield_percent: 80,
      } as IndustrialProposal),
    ).toEqual({
      coverage_semantics: "GOOD_OUTPUT_V1",
      launched_quantity: 130,
      required_good_quantity: 100,
      expected_good_quantity: 104,
      yield_percent: 80,
    });
  });

  it("does not reinterpret old proposals that have no explicit token", () => {
    expect(industrialProposalSnapshot(proposal)).toBeNull();
  });
});
