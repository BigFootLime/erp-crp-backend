import { describe, expect, it } from "vitest";
import type { CutoverRow } from "../../types/data-cutover.types";
import { buildConfirmedWipCheckpoints } from "./wip-preparation.contract";

const row = (values: CutoverRow["values"] = {}): CutoverRow => ({
  id: "ba29ad63-ecc9-4ab8-b8d8-aa99ab96fcef", batch_id: "ba29ad63-ecc9-4ab8-b8d8-aa99ab96fc01", domain: "WIP", legacy_key: "WIP-TEST", source_id: "test", sheet: "atelier", row_number: 1,
  source_values: {}, values: { quantityRemaining: "50", currentPhase: "20", phaseState: "IN_PROGRESS", previousOperationsConfirmed: true, evidenceReference: "Fiche atelier datée, lot physique A", workshopValidator: "Référent atelier", ...values },
  source_issues: [], decision: "INCLUDE", review_note: "", version: 1, status: "READY", issues: [],
});
const phases = [0,10,20,30].map((phase) => ({ phase, designation: `Phase ${phase}` }));

describe("confirmed physical WIP preparation", () => {
  it("uses only the unfinished cohort and preserves an operation started with no output", () => {
    expect(buildConfirmedWipCheckpoints(row({ quantityCompleted: 20, scrapQuantity: 3 }), phases)).toEqual([
      { phase: 0, status: "COMPLETED", quantityGood: 50, quantityScrap: 0, quantityPendingControl: 0, evidenceReference: "Fiche atelier datée, lot physique A" },
      { phase: 10, status: "COMPLETED", quantityGood: 50, quantityScrap: 0, quantityPendingControl: 0, evidenceReference: "Fiche atelier datée, lot physique A" },
      { phase: 20, status: "IN_PROGRESS", quantityGood: 0, quantityScrap: 0, quantityPendingControl: 0, evidenceReference: "Fiche atelier datée, lot physique A" },
      { phase: 30, status: "NOT_STARTED", quantityGood: 0, quantityScrap: 0, quantityPendingControl: 0, evidenceReference: "Fiche atelier datée, lot physique A" },
    ]);
  });
  it("accepts phase zero from the canonical routing", () => {
    expect(buildConfirmedWipCheckpoints(row({ currentPhase: 0, phaseState: "NOT_STARTED", previousOperationsConfirmed: false }), phases).every((point) => point.status === "NOT_STARTED")).toBe(true);
  });
  it("keeps a pause as opening evidence without creating historical execution", () => {
    expect(buildConfirmedWipCheckpoints(row({ phaseState: "PAUSED" }), phases)[2]).toMatchObject({ status: "IN_PROGRESS", quantityGood: 0 });
  });
  it.each([
    [{ previousOperationsConfirmed: false }, "CUTOVER_WIP_SEQUENCE_CONFIRMATION_REQUIRED"],
    [{ evidenceReference: "" }, "CUTOVER_WIP_EVIDENCE_REQUIRED"],
    [{ workshopValidator: "" }, "CUTOVER_WIP_EVIDENCE_REQUIRED"],
    [{ currentPhase: "DECOUPE" }, "CUTOVER_WIP_PHASE_REQUIRED"],
    [{ currentPhase: 40 }, "CUTOVER_WIP_PHASE_REQUIRED"],
    [{ currentPhase: 30, phaseState: "COMPLETED" }, "CUTOVER_WIP_FINISHED_STOCK_REQUIRED"],
    [{ quantityRemaining: "0" }, "CUTOVER_WIP_COHORT_REQUIRED"],
    [{ quantityRemaining: "1e2" }, "CUTOVER_WIP_COHORT_REQUIRED"],
    [{ quantityRemaining: "0.0000001" }, "CUTOVER_WIP_COHORT_REQUIRED"],
    [{ quantityRemaining: "1.00001" }, "CUTOVER_WIP_COHORT_REQUIRED"],
    [{ quantityRemaining: "10000000000" }, "CUTOVER_WIP_COHORT_REQUIRED"],
  ] as const)("refuses incomplete or contradictory preparation %j", (values, code) => {
    expect(() => buildConfirmedWipCheckpoints(row(values), phases)).toThrowError(expect.objectContaining({ code }));
  });
  it("does not choose between duplicate routing phases", () => {
    expect(() => buildConfirmedWipCheckpoints(row(), [...phases, phases[2]])).toThrowError(expect.objectContaining({ code: "CUTOVER_WIP_GAMME_REQUIRED" }));
  });
});
