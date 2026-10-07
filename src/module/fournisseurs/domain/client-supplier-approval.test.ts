import { describe, expect, it } from "vitest";
import {
  approvalRevisionInputSchema,
  assertClientApprovals,
  evaluateClientApproval,
  type ApprovalPolicy,
  type PurchaseClientContext,
} from "./client-supplier-approval";
import {
  purchaseQualificationRevision,
  type PurchaseQualification,
} from "./purchase-qualification";
const supplier = "11111111-1111-4111-8111-111111111111",
  product = "22222222-2222-4222-8222-222222222222",
  purchase = "33333333-3333-4333-8333-333333333333";
const context: PurchaseClientContext = {
  line_id: "44444444-4444-4444-8444-444444444444",
  client_id: "001",
  product_article_id: product,
  purchase_article_id: purchase,
  of_id: 42,
  domains: ["traitements"],
};
function policy(patch: Partial<ApprovalPolicy> = {}): ApprovalPolicy {
  return {
    scope_id: product,
    revision_id: purchase,
    revision: 1,
    client_id: "001",
    product_article_id: null,
    purchase_article_id: null,
    domaine_code: "traitements",
    required: true,
    suspended: false,
    exclusive: false,
    valid_from: "2026-01-01",
    valid_to: "2026-10-07",
    supplier_ids: [supplier],
    evidence: {
      document_id: product,
      version_id: purchase,
      code: "AGR-1",
      title: "Client approval",
      filename: "approval.pdf",
      version_number: 1,
      sha256: "a".repeat(64),
      size_bytes: 100,
    },
    evidence_applicable: true,
    reason: "Approved supplier",
    created_at: "2026-10-01T00:00:00Z",
    ...patch,
  };
}
describe("client supplier approvals", () => {
  it("allows the inclusive last valid day and rejects the following day", () => {
    expect(
      evaluateClientApproval(
        context,
        "traitements",
        supplier,
        [policy()],
        "2026-10-07",
      ).status,
    ).toBe("VALID");
    expect(
      evaluateClientApproval(
        context,
        "traitements",
        supplier,
        [policy()],
        "2026-10-08",
      ).status,
    ).toBe("BLOCKED");
  });
  it("keeps suspension and obsolete evidence blocking", () => {
    for (const patch of [{ suspended: true }, { evidence_applicable: false }])
      expect(() =>
        assertClientApprovals([
          evaluateClientApproval(
            context,
            "traitements",
            supplier,
            [policy(patch)],
            "2026-10-07",
          ),
        ]),
      ).toThrow();
  });
  it("does not use an approval for another client, article or domain", () => {
    for (const patch of [
      { client_id: "002" },
      { product_article_id: purchase },
      { purchase_article_id: product },
      { domaine_code: "matiere_brute" },
    ])
      expect(
        evaluateClientApproval(
          context,
          "traitements",
          supplier,
          [policy(patch)],
          "2026-10-07",
        ).status,
      ).toBe("NOT_CONFIGURED");
  });
  it("requires both general and specific scopes to permit the supplier", () => {
    expect(
      evaluateClientApproval(
        context,
        "traitements",
        supplier,
        [
          policy(),
          policy({
            product_article_id: product,
            purchase_article_id: purchase,
            supplier_ids: [],
            exclusive: true,
          }),
        ],
        "2026-10-07",
      ).status,
    ).toBe("BLOCKED");
  });
  it("checks every client in grouped production", () => {
    const policies = [
      policy(),
      policy({ client_id: "002", supplier_ids: [product] }),
    ];
    const checks = [context, { ...context, client_id: "002", of_id: 43 }].map(
      (c) =>
        evaluateClientApproval(
          c,
          "traitements",
          supplier,
          policies,
          "2026-10-07",
        ),
    );
    expect(checks.map((c) => c.status)).toEqual(["VALID", "BLOCKED"]);
    expect(() => assertClientApprovals(checks)).toThrow();
  });
  it("preserves the existing fingerprint without a configured client policy", () => {
    const state: PurchaseQualification = {
      supplier_id: supplier,
      checked_at: "now",
      today: "2026-10-07",
      can_engage: true,
      global: {
        domain: null,
        line_ids: [],
        decision: null,
        status: "NOT_CONFIGURED",
      },
      domains: [],
      unmapped_line_ids: [],
    };
    const old = purchaseQualificationRevision(state);
    expect(
      purchaseQualificationRevision({
        ...state,
        client_approvals: [
          evaluateClientApproval(
            context,
            "traitements",
            supplier,
            [],
            state.today,
          ),
        ],
      }),
    ).toBe(old);
    expect(
      purchaseQualificationRevision({
        ...state,
        client_approvals: [
          evaluateClientApproval(
            context,
            "traitements",
            supplier,
            [policy()],
            state.today,
          ),
        ],
      }),
    ).not.toBe(old);
  });
  it("rejects an exclusive list containing two suppliers", () => {
    expect(
      approvalRevisionInputSchema.safeParse({
        scope: {
          client_id: "001",
          product_article_id: null,
          purchase_article_id: null,
          domaine_code: "traitements",
        },
        expected_revision_id: null,
        required: true,
        suspended: false,
        exclusive: true,
        valid_from: "2026-10-07",
        valid_to: null,
        supplier_ids: [supplier, product],
        evidence_version_id: purchase,
        reason: "Initial approval",
        idempotency_key: context.line_id,
      }).success,
    ).toBe(false);
  });
});
