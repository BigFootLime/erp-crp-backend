import { describe, expect, it } from "vitest";
import { canonicalJson, duplicateCutoverTargets, hashCutover, inspectCutoverRow, requiredChecklist, summarizeCutover, validateCutoverValues } from "./cutover-validation";
import type { CutoverRow } from "../types/data-cutover.types";
import { createCutoverBatchSchema, patchCutoverRowSchema } from "../validators/data-cutover.validators";

const internal = { affairNumber: "INTERNAL-1", articleReference: "00042", quantityOrdered: 2, quantityCompleted: 0, quantityRemaining: 2, unit: "piece", orderDate: "2026-10-20", plannedDueDate: "2026-10-20" };
const row = (values = internal, decision: CutoverRow["decision"] = "INCLUDE"): CutoverRow => inspectCutoverRow({ id: "00000000-0000-4000-8000-000000000001", batch_id: "00000000-0000-4000-8000-000000000002", domain: "INTERNAL_DEMAND", legacy_key: "INTERNAL:1", source_id: "source-1", sheet: "Orders", row_number: 6, source_values: internal, values, source_issues: [], decision, review_note: "", version: 1 });

describe("cutover preparation validation", () => {
  it("keeps zero quantities and false flags distinct from missing input", () => {
    expect(validateCutoverValues("INTERNAL_DEMAND", internal)).toEqual([]);
    expect(validateCutoverValues("ARTICLE", { articleReference: "00042", resolution: "CREATE", designation: "Example", category: "achat", unit: "piece", familyCode: "DEMO", lotTracked: false })).toEqual([]);
  });
  it("updates remaining issues after one prerequisite is completed", () => {
    const before = validateCutoverValues("INTERNAL_DEMAND", { ...internal, unit: null, plannedDueDate: null });
    expect(before.map((issue) => issue.field)).toEqual(["unit", "plannedDueDate"]);
    const after = validateCutoverValues("INTERNAL_DEMAND", { ...internal, plannedDueDate: null });
    expect(after.map((issue) => issue.field)).toEqual(["plannedDueDate"]);
  });
  it("does not silently round or accept negative residual stock", () => {
    expect(validateCutoverValues("INTERNAL_DEMAND", { ...internal, quantityRemaining: "1.1234567" }).some((issue) => issue.code === "INVALID_DECIMAL")).toBe(true);
    expect(validateCutoverValues("INTERNAL_DEMAND", { ...internal, quantityRemaining: -1 }).some((issue) => issue.code === "NEGATIVE_QUANTITY")).toBe(true);
  });
  it("matches native command precision while keeping stock six-decimal quantities", () => {
    expect(validateCutoverValues("INTERNAL_DEMAND", { ...internal, quantityOrdered: "0.0001", quantityCompleted: "0", quantityRemaining: "0.0001" }).some((issue) => issue.code === "INVALID_DECIMAL")).toBe(true);
    expect(validateCutoverValues("OPENING_STOCK", { stockScope: "OLD", stockKind: "MP", articleReference: "MP-42", quantityCounted: "0.000001", unit: "kg", warehouse: "W", location: "L", qualityStatus: "QUARANTAINE", owner: "CRP", countEvidence: "Comptage confirmé" })).toEqual([]);
  });
  it("compares decimal residuals exactly without binary floating point subtraction", () => {
    expect(validateCutoverValues("INTERNAL_DEMAND", { ...internal, quantityOrdered: "0.3", quantityCompleted: "0.1", quantityRemaining: "0.2" })).toEqual([]);
    expect(validateCutoverValues("INTERNAL_DEMAND", { ...internal, quantityRemaining: 1 }).some((issue) => issue.code === "REMAINING_MISMATCH")).toBe(true);
  });
  it("validates a real calendar date and preserves identifier text", () => {
    expect(validateCutoverValues("INTERNAL_DEMAND", { ...internal, plannedDueDate: "2026-02-30" }).some((issue) => issue.code === "INVALID_DATE")).toBe(true);
    expect(validateCutoverValues("INTERNAL_DEMAND", { ...internal, articleReference: 42 }).some((issue) => issue.code === "INVALID_TEXT")).toBe(true);
  });
  it("does not let a source numeric code authorize linking a client", () => {
    const issues = validateCutoverValues("CUSTOMER", { customerCode: "001", name: "Example", resolution: "LINK" });
    expect(issues.some((issue) => issue.code === "TARGET_REQUIRED")).toBe(true);
  });
  it("keeps incomplete technical pieces out of reviewed preparation", () => {
    const base = { articleReference: "TEST", resolution: "CREATE", customerCode: "001", designation: "Example", planReference: "P-1", technicalStatus: "DRAFT" };
    expect(validateCutoverValues("TECHNICAL_PIECE", base).some((issue) => issue.code === "REVISION_REQUIRED")).toBe(true);
    expect(validateCutoverValues("TECHNICAL_PIECE", { ...base, withoutRevision: true })).toEqual([]);
    expect(validateCutoverValues("TECHNICAL_PIECE", { ...base, externalRevision: "B", withoutRevision: true }).some((issue) => issue.code === "REVISION_CONTRADICTION")).toBe(true);
  });
  it("requires confirmed CREATE addresses but does not ask to recreate an existing linked client", () => {
    expect(validateCutoverValues("CUSTOMER", { customerCode: "001", resolution: "LINK", targetId: "001" })).toEqual([]);
    const created = { customerCode: "001", resolution: "CREATE", name: "Fixture client", address: "1 rue de la Recette", postalCode: "69001", city: "Lyon", country: "FR", creationDate: "2026-10-20" };
    expect(validateCutoverValues("CUSTOMER", created).some((issue) => issue.field === "deliverySameAsBilling")).toBe(true);
    expect(validateCutoverValues("CUSTOMER", { ...created, deliverySameAsBilling: true })).toEqual([]);
    expect(validateCutoverValues("CUSTOMER", { ...created, deliverySameAsBilling: false }).filter((issue) => issue.field?.startsWith("delivery")).map((issue) => issue.field)).toEqual(["deliveryAddress", "deliveryPostalCode", "deliveryCity", "deliveryCountry"]);
  });
  it("keeps the raw old reference separate from the confirmed plan and external revision", () => {
    const values = { ...internal, articleReference: "OLD-REF B", planReference: "PLAN-4587", externalRevision: "B" };
    expect(validateCutoverValues("INTERNAL_DEMAND", values)).toEqual([]);
    expect(row(values).values.articleReference).toBe("OLD-REF B");
    expect(validateCutoverValues("INTERNAL_DEMAND", { ...values, planReference: null }).some((issue) => issue.code === "PLAN_REFERENCE_REQUIRED")).toBe(true);
  });
  it("opening stock is OLD and a zero count remains an explicit observation", () => {
    const stock = { stockScope: "OLD", stockKind: "PF", articleReference: "TEST", quantityCounted: 0, unit: "piece", warehouse: "W-1", location: "S-1", qualityStatus: "QUARANTAINE", owner: "CRP", countEvidence: "Physical count witnessed" };
    expect(validateCutoverValues("OPENING_STOCK", stock).some((issue) => issue.code === "REVISION_REQUIRED")).toBe(true);
    expect(validateCutoverValues("OPENING_STOCK", { ...stock, planReference: "PLAN-TEST", withoutRevision: true })).toEqual([]);
    expect(validateCutoverValues("OPENING_STOCK", { ...stock, stockScope: "NEW" }).some((issue) => issue.field === "stockScope")).toBe(true);
    expect(validateCutoverValues("OPENING_STOCK", { ...stock, quantityReserved: 1 }).some((issue) => issue.code === "RESERVATION_EXCEEDS_STOCK")).toBe(true);
  });
  it("does not replace an unknown opening value with a plausible zero", () => {
    const issues = validateCutoverValues("OPENING_STOCK", { stockScope: "OLD", stockKind: "PF", articleReference: "TEST", quantityCounted: 1, unit: "piece", warehouse: "W", location: "S", qualityStatus: "QUARANTAINE", owner: "CRP", valuationUnitPrice: null, countEvidence: "Count", planReference: "PLAN-TEST", withoutRevision: true });
    expect(issues).toEqual([]);
  });
  it("reconciles invoice opening balances rather than inferring unpaid from the filename", () => {
    const invoice = { documentNumber: "LEGACY-1", documentKind: "INVOICE", partnerCode: "001", documentDate: "2026-10-01", dueDate: "2026-11-01", currency: "EUR", originalAmount: "120.00", paymentsAllocated: "20.00", creditsAllocated: "10.00", depositsAllocated: "30.00", openBalance: "60.00", accountingEvidence: "Accountant balance", documentEvidence: "Issued original" };
    expect(validateCutoverValues("OPENING_RECEIVABLE", invoice)).toEqual([]);
    expect(validateCutoverValues("OPENING_RECEIVABLE", { ...invoice, openBalance: "120.00" }).some((issue) => issue.code === "BALANCE_MISMATCH")).toBe(true);
  });
  it("never marks a source exception resolved merely because other fields are filled", () => {
    expect(validateCutoverValues("INTERNAL_DEMAND", internal, ["Conflicting source date"]).some((issue) => issue.code === "SOURCE_EXCEPTION_REVIEW")).toBe(true);
    expect(validateCutoverValues("INTERNAL_DEMAND", internal, ["Conflicting source date"], "Confirmed against accepted order")).toEqual([]);
  });
  it("keeps undecided and excluded rows outside selected missing counts", () => {
    const rows = [row(), row({ ...internal, unit: "" }, "PENDING"), row({ ...internal, unit: "" }, "EXCLUDE")];
    expect(rows.map((item) => item.status)).toEqual(["READY", "UNDECIDED", "EXCLUDED"]);
    expect(summarizeCutover(rows)).toEqual({ total: 3, included: 1, pending: 1, excluded: 1, missing: 0, ready: 1 });
  });
  it("retains a closed source but refuses using it to create a new zero-quantity order", () => {
    const closed = { ...internal, quantityCompleted: 2, quantityRemaining: 0 };
    expect(validateCutoverValues("INTERNAL_DEMAND", closed)).toEqual([]);
    expect(row(closed, "PENDING").status).toBe("UNDECIDED");
    expect(row(closed, "INCLUDE").issues.some((issue) => issue.code === "NO_OPEN_REMAINDER")).toBe(true);
  });
  it("requires only attestations applicable to included domains", () => {
    expect(requiredChecklist([row()])).toEqual(["sources_frozen", "exclusive_scope", "no_external_emissions"]);
    expect(requiredChecklist([{ ...row(), domain: "OPENING_STOCK" }])).toContain("physical_stock_verified");
    expect(requiredChecklist([{ ...row(), domain: "WIP", decision: "EXCLUDE" }])).not.toContain("wip_verified");
  });
  it("rejects unknown fields instead of treating a typo as a completed input", () => {
    expect(validateCutoverValues("INTERNAL_DEMAND", { ...internal, quntityRemaining: 2 }).some((issue) => issue.code === "UNKNOWN_FIELD")).toBe(true);
  });
  it("blocks duplicate proposed article creations without merging legacy identities", () => {
    const first = { ...row(), domain: "ARTICLE" as const, values: { articleReference: "00042" } };
    const second = { ...first, id: "other", legacy_key: "00042 [ligne 44]" };
    expect(duplicateCutoverTargets([first, second])).toHaveLength(2);
    expect(duplicateCutoverTargets([first, { ...second, decision: "EXCLUDE" }])).toEqual([]);
    expect(duplicateCutoverTargets([{ ...first, values: { ...first.values, targetId: "existing-article" } }, { ...second, values: { ...second.values, targetId: "existing-article" } }])).toEqual([]);
  });
});

describe("private source envelope", () => {
  const input = { name: "Preparation fixture", source_system: "CLIPPER_EXCEL", sources: [{ id: "source-1", name: "example.xlsx", sha256: "a".repeat(64), snapshot_at: "2026-10-20T08:00:00Z" }], rows: [{ domain: "INTERNAL_DEMAND", legacy_key: "INTERNAL:1", source_id: "source-1", sheet: "Orders", row_number: 6, values: internal }] };
  it("binds every row to an identified source and namespaces its legacy identity", () => {
    expect(createCutoverBatchSchema.safeParse(input).success).toBe(true);
    expect(createCutoverBatchSchema.safeParse({ ...input, rows: [{ ...input.rows[0], source_id: "not-listed" }] }).success).toBe(false);
    expect(createCutoverBatchSchema.safeParse({ ...input, rows: [input.rows[0], input.rows[0]] }).success).toBe(false);
    expect(createCutoverBatchSchema.safeParse({ ...input, rows: [{ ...input.rows[0], values: { ...internal, privateDataNotNeeded: "unnecessary" } }] }).success).toBe(false);
  });
  it("accepts identities repeated across different business domains", () => {
    expect(createCutoverBatchSchema.safeParse({ ...input, rows: [input.rows[0], { ...input.rows[0], domain: "WIP", values: {} }] }).success).toBe(true);
  });
  it("rejects source paths and executable structure", () => {
    expect(createCutoverBatchSchema.safeParse({ ...input, sources: [{ ...input.sources[0], name: "C:/private/example.xlsx" }] }).success).toBe(false);
    expect(patchCutoverRowSchema.safeParse({ expected_version: 1, decision: "INCLUDE", values: JSON.parse('{"__proto__":{"polluted":true}}') }).success).toBe(false);
  });
  it("requires a row version for every edit", () => {
    expect(patchCutoverRowSchema.safeParse({ values: internal, decision: "INCLUDE" }).success).toBe(false);
  });
  it("hashes the entire exact content deterministically", () => {
    expect(canonicalJson({ b: [1, 2], a: false })).toBe('{"a":false,"b":[1,2]}');
    expect(hashCutover({ a: 1, b: 2 })).toBe(hashCutover({ b: 2, a: 1 }));
    expect(hashCutover({ a: 1 })).not.toBe(hashCutover({ a: 2 }));
  });
});
