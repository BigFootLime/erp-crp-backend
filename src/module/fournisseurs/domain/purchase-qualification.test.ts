import { describe, expect, it } from "vitest";
import {
  assertPurchaseQualification,
  purchaseLineDomains,
  purchaseQualificationRevision,
  qualificationScope,
  type PurchaseQualification,
  type PurchaseScopeLine,
  type QualificationDecision,
} from "./purchase-qualification";

const approved: QualificationDecision = {
  id: "a",
  version: 2,
  statut: "homologue",
  domaine_code: "traitements",
  valid_from: "2026-10-01",
  valid_to: "2026-10-07",
  document_id: "proof",
  reference: "QUAL-42",
  organisme: null,
  perimetre: "Anodisation",
  updated_at: "2026-10-01T10:00:00Z",
};
const line: PurchaseScopeLine = {
  id: "line",
  position: 1,
  type: "SOUS_TRAITANCE",
  catalogue_type: "SOUS_TRAITANCE",
  categories: ["traitement_surface"],
};
function state(
  decision: QualificationDecision | null = approved,
  today = "2026-10-07",
): PurchaseQualification {
  const global = qualificationScope(
    null,
    ["line"],
    { ...approved, domaine_code: null },
    today,
  );
  const domain = qualificationScope("traitements", ["line"], decision, today);
  return {
    supplier_id: "supplier",
    checked_at: "2026-10-07T10:00:00Z",
    today,
    global,
    domains: [domain],
    unmapped_line_ids: [],
    can_engage: domain.status !== "BLOCKED",
  };
}
describe("supplier qualification for the actual purchase scope", () => {
  it("uses treatment category instead of generic subcontracting, and reports an unmapped free line", () => {
    expect(purchaseLineDomains(line)).toEqual(["traitements"]);
    expect(
      purchaseLineDomains({
        ...line,
        type: "ARTICLE",
        catalogue_type: null,
        categories: [],
      }),
    ).toEqual([]);
    expect(
      purchaseLineDomains({
        ...line,
        type: "MATIERE",
        catalogue_type: null,
        categories: [],
      }),
    ).toEqual(["matiere_brute"]);
  });
  it("does not let a global approval override a suspended scoped decision", () => {
    expect(() =>
      assertPurchaseQualification(state({ ...approved, statut: "suspendu" })),
    ).toThrowError(
      expect.objectContaining({
        code: "SUPPLIER_DOMAIN_HOMOLOGATION_NOT_VALID",
      }),
    );
  });
  it("accepts inclusive dates and refuses engagement after expiration", () => {
    expect(() => assertPurchaseQualification(state())).not.toThrow();
    expect(() =>
      assertPurchaseQualification(state(approved, "2026-10-08")),
    ).toThrow();
  });
  it("represents missing decisions explicitly without claiming approval", () => {
    expect(state(null).domains[0].status).toBe("NOT_CONFIGURED");
    expect(() => assertPurchaseQualification(state(null))).not.toThrow();
  });
  it("invalidates a prepared purchase after same-version decision or scope edits", () => {
    expect(
      purchaseQualificationRevision(
        state({ ...approved, perimetre: "Autre prestation" }),
      ),
    ).not.toBe(purchaseQualificationRevision(state()));
    expect(
      purchaseQualificationRevision({
        ...state(),
        unmapped_line_ids: ["new-line"],
      }),
    ).not.toBe(purchaseQualificationRevision(state()));
  });
  it("preserves document validity when only the observation time changes", () => {
    expect(
      purchaseQualificationRevision({
        ...state(),
        checked_at: "2026-10-07T12:00:00Z",
      }),
    ).toBe(purchaseQualificationRevision(state()));
  });
});
