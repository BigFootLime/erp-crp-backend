import { describe, expect, it } from "vitest";
import {
  evaluatePreparation,
  isPreparationReady,
  planningUrgency,
  sourceHash,
  type PreparationFacts,
} from "./preparation-rules";
function complete(): PreparationFacts {
  return {
    version_id: "v2",
    version_status: "APPLICABLE",
    version_current: true,
    manufacturing_mode: "SIMPLE",
    decisions: {
      treatment: { mode: "NOT_REQUIRED", reason: "Pièce brute" },
      subcontract: { mode: "NOT_REQUIRED", reason: "Fabrication interne" },
      programming: { mode: "NONE", reason: "Travail manuel" },
    },
    purchases: [
      {
        id: "mp",
        type_achat: "MATIERE",
        article_id: "a",
        designation: "Aluminium 6082",
        quantite: 1,
        unite_prix: "KG",
        fournisseur_id: null,
        piece_technique_version_id: "v2",
      },
    ],
    client_plan_count: 1,
    manufacturing_plan_count: 0,
    required_documents_missing: 0,
    routing_count: 2,
    invalid_operations: 0,
    component_count: 0,
    invalid_components: 0,
    quality_plan_id: "q2",
    quality_characteristic_count: 3,
    programming_task_valid: false,
    stock_review_current: true,
    sheet_current: true,
  };
}
describe("Source-backed production preparation", () => {
  it("accepts a complete manual piece with justified non-applicable services", () =>
    expect(isPreparationReady(evaluatePreparation(complete()))).toBe(true));
  it.each([
    "client_plan_count",
    "routing_count",
    "quality_characteristic_count",
  ] as const)(
    "blocks missing %s even with arbitrary confirmation metadata",
    (key) => {
      const f = {
        ...complete(),
        [key]: 0,
        sections: {
          plan: { confirmed: true },
          routing: { confirmed: true },
          quality: { confirmed: true },
        },
      };
      expect(isPreparationReady(evaluatePreparation(f))).toBe(false);
    },
  );
  it("never accepts material from another revision", () => {
    const f = complete();
    f.purchases[0].piece_technique_version_id = "v1";
    expect(
      evaluatePreparation(f).find((i) => i.key === "material")?.status,
    ).toBe("MISSING");
  });
  it("requires a positive quantity and a stock article for the material", () => {
    const f = complete();
    f.purchases[0].quantite = 0;
    f.purchases[0].article_id = null;
    expect(isPreparationReady(evaluatePreparation(f))).toBe(false);
  });
  it("does not hide contradictory purchases behind a non-applicable decision", () => {
    const f = complete();
    f.purchases.push({
      ...f.purchases[0],
      id: "tr",
      type_achat: "TRAITEMENT",
      fournisseur_id: null,
    });
    expect(
      evaluatePreparation(f).find((i) => i.key === "treatment")?.status,
    ).toBe("MISSING");
  });
  it("keeps manufacturing drawing optional unless explicitly required", () => {
    const f = complete();
    expect(isPreparationReady(evaluatePreparation(f))).toBe(true);
    f.decisions.manufacturing_plan_required = true;
    expect(isPreparationReady(evaluatePreparation(f))).toBe(false);
  });
  it("requires assembly components independently of child OF position", () => {
    const f = complete();
    f.manufacturing_mode = "ASSEMBLY";
    expect(isPreparationReady(evaluatePreparation(f))).toBe(false);
    f.component_count = 2;
    expect(isPreparationReady(evaluatePreparation(f))).toBe(true);
  });
  it("requires an assigned, estimated programming task but allows its completion after planning", () => {
    const f = complete();
    f.decisions.programming = {
      mode: "TASK",
      task_id: "task",
      estimated_hours: 2,
    };
    expect(isPreparationReady(evaluatePreparation(f))).toBe(false);
    f.programming_task_valid = true;
    expect(isPreparationReady(evaluatePreparation(f))).toBe(true);
  });
  it.each(["stock_review_current", "sheet_current"] as const)(
    "does not inherit OF-specific evidence: %s",
    (key) => {
      const f = { ...complete(), [key]: false };
      expect(isPreparationReady(evaluatePreparation(f))).toBe(false);
    },
  );
  it("rejects obsolete and non-current revisions", () => {
    const f = complete();
    f.version_status = "OBSOLETE";
    expect(isPreparationReady(evaluatePreparation(f))).toBe(false);
    f.version_status = "APPLICABLE";
    f.version_current = false;
    expect(isPreparationReady(evaluatePreparation(f))).toBe(false);
  });
  it("hashes field order identically, while preserving phase order and changes", () => {
    expect(sourceHash({ b: 2, a: { x: 1, y: 2 } })).toBe(
      sourceHash({ a: { y: 2, x: 1 }, b: 2 }),
    );
    expect(sourceHash([1, 2])).not.toBe(sourceHash([2, 1]));
  });
});
describe("48 elapsed hours, using the production clock", () => {
  const base = {
    waitStartedAt: "2026-10-24T12:00:00+02:00",
    status: "BROUILLON",
    totalOperations: 2,
    plannedOperations: 0,
    covered: false,
  };
  it.each([
    ["2026-10-26T09:59:00Z", false],
    ["2026-10-26T10:00:00Z", true],
    ["2026-10-26T10:01:00Z", true],
  ] as const)(
    "handles exact threshold and daylight saving: %s",
    (now, overdue) =>
      expect(planningUrgency({ ...base, now: new Date(now) }).overdue).toBe(
        overdue,
      ),
  );
  it("remains urgent when PLANIFIE is only partially scheduled", () =>
    expect(
      planningUrgency({
        ...base,
        now: new Date("2026-10-27Z"),
        status: "PLANIFIE",
        plannedOperations: 1,
      }),
    ).toMatchObject({ overdue: true, planning_state: "PARTIAL" }));
  it.each(["TERMINE", "ANNULE", "EN_COURS", "EN_PAUSE"])(
    "does not prioritise closed or already running OFs: %s",
    (status) =>
      expect(
        planningUrgency({ ...base, status, now: new Date("2026-10-27Z") })
          .overdue,
      ).toBe(false),
  );
  it("removes only covered sources and fully planned OFs from the urgent queue", () => {
    expect(
      planningUrgency({ ...base, covered: true, now: new Date("2026-10-27Z") })
        .overdue,
    ).toBe(false);
    expect(
      planningUrgency({
        ...base,
        plannedOperations: 2,
        now: new Date("2026-10-27Z"),
      }).overdue,
    ).toBe(false);
  });
});
