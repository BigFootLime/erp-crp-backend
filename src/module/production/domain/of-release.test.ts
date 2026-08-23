import { describe, expect, it } from "vitest";
import { canTransitionOfStatut, ofStatutAllowsExecution } from "./of-status";
import { releaseOfSchema } from "../validators/production.validators";

describe("OF explicit release boundary (#617)", () => {
  it("does not expose an implicit draft/planned to execution transition", () => {
    expect(canTransitionOfStatut("BROUILLON", "EN_COURS")).toBe(false);
    expect(canTransitionOfStatut("PLANIFIE", "EN_COURS")).toBe(false);
    expect(ofStatutAllowsExecution("BROUILLON")).toBe(false);
    expect(ofStatutAllowsExecution("PLANIFIE")).toBe(false);
    expect(ofStatutAllowsExecution("EN_COURS")).toBe(true);
    expect(ofStatutAllowsExecution("EN_PAUSE")).toBe(true);
  });

  it("requires a reason and an explicit blocker selection for an override", () => {
    expect(() => releaseOfSchema.parse({ body: { override: true } })).toThrow();
    expect(() => releaseOfSchema.parse({ body: { override: true, override_reason: "Reason with enough detail", override_blocker_codes: [] } })).toThrow();
    expect(() => releaseOfSchema.parse({ body: { override: false, override_reason: "This must not be accepted" } })).toThrow();
    expect(releaseOfSchema.parse({ body: { override: true, override_reason: "Customer-approved controlled deviation", override_blocker_codes: ["QUALITY_PLAN_MISSING"] } }).body.override).toBe(true);
  });
});
