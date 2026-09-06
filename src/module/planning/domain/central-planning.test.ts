import { describe, expect, it } from "vitest";
import { estimateDuration } from "./central-estimation";
import { outstanding, proposeCoverage, sourceAvailable } from "./central-coverage";
import { addWorkingDays, expandCalendar } from "./central-calendar";
import { capacitySlot, schedule } from "./central-scheduler";
import type { CentralTask, CoverageSource, Demand, Resource } from "../types/planning-central.types";
const from = "2026-09-07T06:00:00.000Z";
const resource: Resource = { id: "machine:1", kind: "MACHINE", label: "DMU", timezone: "Europe/Paris",
  version: "1", availability: [{ start: from, end: "2026-09-07T10:00:00.000Z" }, { start: "2026-09-08T06:00:00.000Z", end: "2026-09-08T16:00:00.000Z" }] };
function task(id: string, patch: Partial<CentralTask> = {}): CentralTask {
  return { id, source: "OPERATION", operationId: id, programmingId: null, ofId: 1, orderId: 1,
    ofNumber: "OF-1", reference: "PIECE", revision: "C", label: id, view: "machines", internal: false,
    internalPurpose: null, quantity: 100, good: 0, scrap: 0, rework: 0, released: 0, resourceIds: ["machine:1"],
    eligibleResourceIds: ["machine:1"], committed: null, forecast: null, actual: null, commitment: "FORECAST",
    locked: false, readiness: "READY", blockers: [], earliestStart: null, due: null, priority: 0, createdAt: from,
    version: "1", estimate: estimateDuration({ contextKey: id, routingSetupMinutes: 0, routingUnitMinutes: 1,
      quantity: 100, good: 0, scrap: 0, rework: 0, observations: [] }), ...patch };
}
const supply: CoverageSource = { id: "of:100", kind: "FORECAST", articleId: "piece", revision: "C", unit: "PCE",
  contractId: null, quantity: 100, usable: true, availableAt: from, version: "1" };
const demand: Demand = { id: "line:1", articleId: "piece", compatibleRevisions: ["C"], unit: "PCE", contractId: null, quantity: 60, due: from };
const allocations = [{ id: "a", sourceId: supply.id, demandId: demand.id, quantity: 60, transferredQuantity: 0, cancelled: false },
  { id: "b", sourceId: supply.id, demandId: "line:2", quantity: 25, transferredQuantity: 0, cancelled: false }];
describe("planning central — couverture économique", () => {
  it("100 à produire, 60 + 25 affectées, 15 libres sans créer de nouvelle charge", () => {
    expect(sourceAvailable(supply, allocations)).toBe(15);
    const result = proposeCoverage([demand, { ...demand, id: "line:2", quantity: 25 }], [supply], allocations);
    expect(result.map(r => r.missing)).toEqual([0, 0]);
    expect(result.flatMap(r => r.allocations)).toEqual([]);
    expect(supply.quantity).toBe(100);
  });
  it("40 réceptionnées: 40 physiques réservées, 60 encore attendues, toujours 15 libres", () => {
    const physical = { ...supply, id: "lot:1", kind: "PHYSICAL" as const, quantity: 40 };
    const next = [{ ...allocations[0], transferredQuantity: 40 }, allocations[1],
      { ...allocations[0], id: "stock-reservation:1", sourceId: physical.id, quantity: 40 }];
    expect(sourceAvailable({ ...supply, quantity: 60 }, next) + sourceAvailable(physical, next)).toBe(15);
    expect(proposeCoverage([demand], [{ ...supply, quantity: 60 }, physical], next)[0]).toMatchObject({ existing: 60, missing: 0, allocations: [] });
  });
  it("quarantaine, indice, unité et périmètre incompatible ne couvrent pas un besoin", () => {
    const sources = [
      { ...supply, id: "quarantine", usable: false },
      { ...supply, id: "revision", revision: "B" },
      { ...supply, id: "unit", unit: "KG" },
      { ...supply, id: "scope", contractId: "other" },
    ];
    expect(proposeCoverage([demand], sources, [])[0].missing).toBe(60);
  });
  it("considère les besoins non réservés et ne suraffecte pas entre commandes", () => {
    const result = proposeCoverage([demand, { ...demand, id: "line:2" }], [supply], []);
    expect(result.map(r => r.missing)).toEqual([0, 20]);
    expect(result.flatMap(r => r.allocations).reduce((s, a) => s + a.quantity, 0)).toBe(100);
    expect(result[0].allocations[0].unsecured).toBe(true);
  });
  it("annulation libère uniquement l'affectation et garde l'OF à 100", () => {
    expect(sourceAvailable(supply, [{ ...allocations[0], cancelled: true }, allocations[1]])).toBe(75);
    expect(supply.quantity).toBe(100);
    expect(() => outstanding({ ...allocations[0], transferredQuantity: 61 })).toThrow();
  });
  it("une promesse existante tardive reste affectée, avec risque visible", () => {
    const result = proposeCoverage([demand], [{ ...supply, availableAt: "2026-10-01T00:00:00Z" }], allocations);
    expect(result[0].risks).toContain("LATE:of:100");
    expect(result[0].allocations).toEqual([]);
  });
});
describe("planning central — estimation explicable", () => {
  const base = { contextKey: "R:C:FRAISAGE:DMU:P1", routingSetupMinutes: 60, routingUnitMinutes: 10, quantity: 100,
    good: 20, scrap: 5, rework: 2, setupCompletedMinutes: 30, observations: [] };
  it("sépare réglage restant, pièces restant à traiter et reprises", () => {
    expect(estimateDuration(base)).toMatchObject({ remainingMinutes: 800, confidence: "INITIAL", provenance: "ROUTING" });
  });
  it("apprend sur les 20 observations validées comparables, avec médiane robuste", () => {
    const observations = Array.from({ length: 30 }, (_, i) => ({ id: String(i), contextKey: base.contextKey, validated: true,
      recordedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(), productiveMinutes: i === 29 ? 999999 : 80,
      quantity: 10, setupMinutes: null }));
    const result = estimateDuration({ ...base, observations });
    expect(result.observations).toBe(20);
    expect(result.unitMinutes).toBeCloseTo(8.4);
    expect(result.dispersionMinutes).toBe(0);
    expect(result.confidence).toBe("CONSOLIDATED");
  });
  it("exclut ancien contexte, ambiguïté et données non validées; correction rejouable", () => {
    const o = { id: "1", contextKey: base.contextKey, validated: true, recordedAt: from, productiveMinutes: 60, quantity: 10, setupMinutes: null };
    const result = estimateDuration({ ...base, observations: [o, { ...o, id: "2", contextKey: "old" },
      { ...o, id: "3", excludedReason: "LEGACY_MIXED_TIME" }, { ...o, id: "4", validated: false }] });
    expect(result.observations).toBe(1);
    expect(result.excluded).toHaveLength(3);
    expect(estimateDuration({ ...base, observations: [{ ...o, excludedReason: "CANCELLED" }] }).provenance).toBe("ROUTING");
  });
  it("le réel courant est provisoire et ne devient pas historique implicitement", () => {
    const result = estimateDuration({ ...base, current: { productiveMinutes: 100, attributableQuantity: 20 } });
    expect(result.provisional).toBe(true);
    expect(result.observations).toBe(0);
    expect(result.unitMinutes).toBeCloseTo(6.666666);
  });
});
describe("planning central — contraintes et engagement", () => {
  it("une machine et son poste partagent la capacité physique", () => {
    const poste = { ...resource, id:"poste:1", capacityId:resource.id, kind:"POSTE" as const };
    const fixed = task("running", {commitment:"STARTED",committed:{start:from,end:"2026-09-07T10:00:00.000Z"}});
    const pending = task("pending", {resourceIds:[poste.id],eligibleResourceIds:[poste.id]});
    const result = schedule({tasks:[fixed,pending],resources:[resource,poste],dependencies:[],from,
      requested:[{taskId:pending.id,earliestStart:from}]});
    expect(result.feasible).toBe(true);
    expect(result.changes[0].after.start).toBe("2026-09-08T06:00:00.000Z");
  });
  it("choisit automatiquement la machine qualifiée qui termine le plus tôt, sans déplacer l’encours", () => {
    const alternative = { ...resource, id:"machine:2" };
    const fixed = task("running", {commitment:"STARTED",committed:{start:from,end:"2026-09-07T10:00:00.000Z"}});
    const pending = task("auto", {eligibleResourceIds:[resource.id,alternative.id]});
    const result = schedule({tasks:[fixed,pending],resources:[resource,alternative],dependencies:[],from,
      requested:[{taskId:pending.id,earliestStart:from,autoAssign:true}]});
    expect(result.feasible).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].resourceIds).toEqual([alternative.id]);
    expect(result.changes[0].after.start).toBe(from);
    expect(fixed.committed?.end).toBe("2026-09-07T10:00:00.000Z");
  });
  it("départage les machines de façon stable et ne choisit jamais une machine non qualifiée", () => {
    const a={...resource,id:"machine:a"},b={...resource,id:"machine:b"},c={...resource,id:"machine:0"};
    const t=task("auto",{resourceIds:[],eligibleResourceIds:[b.id,a.id]});
    const calculate=(resources:Resource[])=>schedule({tasks:[t],resources,dependencies:[],from,
      requested:[{taskId:t.id,earliestStart:from,autoAssign:true}]});
    expect(calculate([b,a,c]).changes[0].resourceIds).toEqual([a.id]);
    expect(calculate([c,a,b])).toEqual(calculate([b,a,c]));
    expect(calculate([c]).feasible).toBe(false);
  });
  it("répartit plusieurs OF par priorité puis échéance avec une capacité commune", () => {
    const tasks=[task("ordinary"),task("urgent",{priority:3}),task("due",{due:from})];
    const result=schedule({tasks,resources:[resource],dependencies:[],from,
      requested:tasks.map(t=>({taskId:t.id,earliestStart:from,autoAssign:true}))});
    expect(result.feasible).toBe(true);
    expect(result.changes.map(change=>change.taskId)).toEqual(["urgent","due","ordinary"]);
    expect(Date.parse(result.forecasts.due.start)).toBeGreaterThanOrEqual(Date.parse(result.forecasts.urgent.end));
  });
  it("découpe et programme parallèles, fraisage après les deux", () => {
    const resources = [resource, { ...resource, id: "person:1", kind: "PERSON" as const }];
    const tasks = [task("cut"), task("program", { resourceIds: ["person:1"], eligibleResourceIds: ["person:1"] }), task("mill")];
    const result = schedule({ tasks, resources, from, dependencies: ["cut", "program"].map(id => ({
      predecessorId: id, successorId: "mill", transferQuantity: null, releasedQuantity: 0, lagMinutes: 0 })),
      requested: tasks.map(t => ({ taskId: t.id, earliestStart: from })) });
    expect(result.feasible).toBe(true);
    expect(result.forecasts.cut.start).toBe(result.forecasts.program.start);
    expect(result.forecasts.mill.start).toBe(result.forecasts.cut.end);
    expect(tasks.every(t => t.committed === null)).toBe(true);
  });
  it("ne déplace ni les opérations commencées ni les verrous", () => {
    const fixed = task("running", { commitment: "STARTED", committed: { start: from, end: "2026-09-07T08:00:00.000Z" } });
    const result = schedule({ tasks: [fixed, task("new")], resources: [resource], dependencies: [], from,
      requested: [{ taskId: "new", earliestStart: from }] });
    expect(result.changes[0].after.start).toBe(fixed.committed!.end);
    expect(result.changes).toHaveLength(1);
  });
  it("transfert partiel débloque uniquement lorsque la quantité autorisée est libérée", () => {
    const parent = task("cut", { resourceIds: [] }), child = task("mill");
    const run = (releasedQuantity: number) => schedule({ tasks: [parent, child], resources: [resource], from,
      dependencies: [{ predecessorId: "cut", successorId: "mill", transferQuantity: 20, releasedQuantity, lagMinutes: 0 }],
      requested: [{ taskId: "mill", earliestStart: from }] });
    expect(run(19).feasible).toBe(false);
    expect(run(20).feasible).toBe(true);
  });
  it("rejette les cycles, durées absentes et ressources non qualifiées", () => {
    const tasks = [task("a"), task("b")];
    const cycle = schedule({ tasks, resources: [resource], from, requested: tasks.map(t => ({ taskId: t.id, earliestStart: from })),
      dependencies: [["a", "b"], ["b", "a"]].map(([predecessorId, successorId]) => ({ predecessorId, successorId, transferQuantity: null, releasedQuantity: 0, lagMinutes: 0 })) });
    expect(cycle.conflicts[0].code).toBe("DEPENDENCY_CYCLE");
    const unknown = schedule({ tasks: [task("draft", { estimate: null })], resources: [], dependencies: [], from,
      requested: [{ taskId: "draft", earliestStart: from }] });
    expect(unknown.conflicts[0].code).toBe("DURATION_MISSING");
  });
  it("consomme des heures ouvertes sans traverser la réservation d'une autre opération", () => {
    expect(capacitySlot([resource], new Map(), Date.parse(from), 300)?.end).toBe("2026-09-08T07:00:00.000Z");
    const occupied = new Map([[resource.id, [{ start: "2026-09-07T08:00:00.000Z", end: "2026-09-07T09:00:00.000Z" }]]]);
    expect(capacitySlot([resource], occupied, Date.parse(from), 300)?.start).toBe("2026-09-07T09:00:00.000Z");
  });
});
describe("planning central — temps civil", () => {
  it("respecte le passage à l'heure d'hiver: une heure locale répétée vaut 120 minutes", () => {
    const windows = expandCalendar({ timezone: "Europe/Paris", shifts: [{ weekday: 0, startMinute: 120, endMinute: 180 }],
      closures: [], closedDates: [] }, "2026-10-25T00:00:00Z", "2026-10-25T04:00:00Z");
    expect(windows).toEqual([{ start: "2026-10-25T00:00:00.000Z", end: "2026-10-25T02:00:00.000Z" }]);
  });
  it("l'heure locale sautée au printemps ne crée aucune capacité", () => {
    expect(expandCalendar({ timezone: "Europe/Paris", shifts: [{ weekday: 0, startMinute: 120, endMinute: 180 }],
      closures: [], closedDates: [] }, "2026-03-29T00:00:00Z", "2026-03-29T04:00:00Z")).toEqual([]);
  });
  it("cinq jours ouvrés fournisseur respectent fermeture et changement d'année", () => {
    expect(addWorkingDays("2026-12-28T08:00:00.000Z", 5, "Europe/Paris", ["2027-01-01"])).toBe("2027-01-05T08:00:00.000Z");
    expect(addWorkingDays("2026-10-23T06:00:00.000Z", 1, "Europe/Paris")).toBe("2026-10-26T07:00:00.000Z");
  });
});
