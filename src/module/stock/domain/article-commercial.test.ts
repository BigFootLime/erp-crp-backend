import { describe, it, expect } from "vitest";
import { assertArticleCommercial } from "./article-commercial";
const base = {
  finished: true,
  scope: "CLIENTS",
  clients: ["001", "002"],
  internalReference: null,
  requireQualification: true,
};
describe("finished article commercial ownership", () => {
  it("associates several customers with one article", () =>
    expect(() => assertArticleCommercial(base)).not.toThrow());
  it("requires a customer for customer mode", () =>
    expect(() => assertArticleCommercial({ ...base, clients: [] })).toThrow());
  it("accepts CRP with internal reference and no customers", () =>
    expect(() =>
      assertArticleCommercial({
        ...base,
        scope: "CRP",
        clients: [],
        internalReference: "CRP-001",
      }),
    ).not.toThrow());
  it.each([
    { scope: "CRP", clients: ["001"], internalReference: "CRP-001" },
    { scope: "CRP", clients: [], internalReference: null },
    { scope: null, clients: [], internalReference: null },
  ])("rejects incoherent or absent choices %j", (patch) =>
    expect(() => assertArticleCommercial({ ...base, ...patch })).toThrow(),
  );
  it("does not relabel ambiguous history as CRP", () =>
    expect(() =>
      assertArticleCommercial({
        ...base,
        scope: null,
        clients: [],
        requireQualification: false,
      }),
    ).not.toThrow());
  it("does not confuse ordinary consumables with finished articles", () =>
    expect(() =>
      assertArticleCommercial({
        ...base,
        finished: false,
        scope: null,
        clients: [],
      }),
    ).not.toThrow());
});
