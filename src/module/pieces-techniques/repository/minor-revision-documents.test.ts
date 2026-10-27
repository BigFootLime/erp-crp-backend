import { describe, expect, it, vi } from "vitest";
import { canCarryMinorRevisionDocuments, copyMinorRevisionDocumentsTx } from "./minor-revision-documents";
const samePlan = { changeLevel: "MINOR", sourceIndex: "A", targetIndex: "A", sourcePlan: "045-13965", targetPlan: "045-13965" };
describe("Internal revision document continuity", () => {
  it("keeps the existing drawings when only purchases change", () => expect(canCarryMinorRevisionDocuments(samePlan)).toBe(true));
  it.each([
    { changeLevel: "MAJOR" }, { targetIndex: "B" }, { targetPlan: "045-13966" }, { targetPlan: null },
  ])("does not inherit approval for a changed drawing: %j", change => expect(canCarryMinorRevisionDocuments({ ...samePlan, ...change })).toBe(false));
  it("binds the original part, both revisions and the actor within the existing transaction", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 2 });
    expect(await copyMinorRevisionDocumentsTx({ query }, "piece", "source", "target", 7)).toBe(2);
    expect(query).toHaveBeenCalledWith(expect.any(String), ["piece", "source", "target", 7]);
  });
});
