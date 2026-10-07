import { describe, expect, it } from "vitest";
import { assertGlobalPurchaseHomologation, type PurchaseHomologation } from "./purchase-homologation";

const valid: PurchaseHomologation = { id: "qualification", version: 2, statut: "homologue", valid_from: "2026-10-01", valid_to: "2026-10-07", document_id: "document" };
describe("global supplier qualification at purchase commitment", () => {
  it("accepts the inclusive validity dates, without fabricating a decision when none exists", () => {
    expect(() => assertGlobalPurchaseHomologation(valid, "2026-10-01")).not.toThrow();
    expect(() => assertGlobalPurchaseHomologation(valid, "2026-10-07")).not.toThrow();
    expect(() => assertGlobalPurchaseHomologation(null, "2026-10-07")).not.toThrow();
  });
  it.each(["a_qualifier", "en_cours", "sous_reserve", "suspendu", "refuse", "expire"])("refuses a global %s decision", statut => {
    expect(() => assertGlobalPurchaseHomologation({ ...valid, statut }, "2026-10-07")).toThrowError(expect.objectContaining({ code: "SUPPLIER_HOMOLOGATION_NOT_VALID" }));
  });
  it.each(["2026-09-30", "2026-10-08"])("refuses an otherwise approved decision outside its validity on %s", today => {
    expect(() => assertGlobalPurchaseHomologation(valid, today)).toThrow();
  });
});
