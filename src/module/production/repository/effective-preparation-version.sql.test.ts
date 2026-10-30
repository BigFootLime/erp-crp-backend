import { describe, expect, it } from "vitest";
import { canAutoFollowCompatibleRevision } from "./effective-preparation-version.sql";

describe("effective preparation revision", () => {
  const draft = { statut: "BROUILLON", technicalSnapshotSha256: null, technicalReadiness: "INCOMPLETE" } as const;
  it("follows only AUTO or legacy drafts on an identical non-empty client index", () => {
    const input = { state: draft, effectiveVersionId: "old", sourceVersionId: "old", sourceClientIndex: "A", targetClientIndex: "A" };
    expect(canAutoFollowCompatibleRevision(input)).toBe(true);
    expect(canAutoFollowCompatibleRevision({ ...input, mode: "MANUAL" })).toBe(false);
    expect(canAutoFollowCompatibleRevision({ ...input, targetClientIndex: "B" })).toBe(false);
    expect(canAutoFollowCompatibleRevision({ ...input, sourceClientIndex: null })).toBe(false);
    expect(canAutoFollowCompatibleRevision({ ...input, targetChangeLevel: "MAJOR" })).toBe(false);
    expect(canAutoFollowCompatibleRevision({ ...input, targetInterchangeable: true })).toBe(false);
    expect(canAutoFollowCompatibleRevision({ ...input, state: { ...draft, technicalReadiness: "VALIDATED" } })).toBe(false);
  });
});
