import { describe, it, expect } from "vitest";
import { externalCompletion, promiseEnd } from "./external-schedule";
import { expandCalendar } from "./central-calendar";
import { schedule } from "./central-scheduler";
import type { CentralTask, Resource } from "../types/planning-central.types";
import type { SubcontractFlow } from "../../subcontract/subcontract-flow.types";
const from = "2026-09-14T06:00:00.000Z",
  to = "2026-10-10T20:00:00.000Z";
const supplier: Resource = {
  id: "supplier:s",
  kind: "SUPPLIER",
  label: "Traitement",
  version: "1",
  timezone: "Europe/Paris",
  availability: expandCalendar(
    {
      timezone: "Europe/Paris",
      shifts: [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        startMinute: 480,
        endMinute: 960,
      })),
      closures: [],
      closedDates: ["2026-09-16"],
    },
    from,
    to,
  ),
};
const flow: SubcontractFlow = {
  packageId: "p",
  operationId: "external",
  ofId: 1,
  supplierId: "s",
  supplierName: "Traitement",
  orderId: "order",
  orderCode: "CF",
  orderLineId: "line",
  unit: "u",
  planned: 100,
  issued: 100,
  returned: 40,
  custody: 60,
  released: 40,
  transferred: 40,
  promisedDate: "2026-09-23",
  promiseSource: "LINE",
  departedAt: from,
  lastReturnAt: from,
  status: "SENT",
  returns: [],
  version: "v1",
};
const task = (id: string, patch: Partial<CentralTask> = {}): CentralTask => ({
  id,
  source: "OPERATION",
  operationId: id,
  programmingId: null,
  ofId: 1,
  orderId: null,
  ofNumber: "OF1",
  reference: "P",
  revision: "A",
  label: id,
  view: "machines",
  internal: false,
  internalPurpose: null,
  quantity: 100,
  good: 0,
  scrap: 0,
  rework: 0,
  released: 0,
  resourceIds: ["machine:m"],
  eligibleResourceIds: ["machine:m"],
  committed: null,
  forecast: null,
  actual: null,
  commitment: "FORECAST",
  locked: false,
  readiness: "READY",
  blockers: [],
  earliestStart: from,
  due: null,
  priority: 0,
  createdAt: from,
  version: "1",
  estimate: {
    policy: "TEST",
    setupMinutes: 0,
    unitMinutes: 1,
    remainingMinutes: 100,
    provenance: "ROUTING",
    confidence: "INITIAL",
    observations: 0,
    dispersionMinutes: null,
    provisional: true,
    excluded: [],
  },
  ...patch,
});
const external = () =>
  task("external", {
    view: "external",
    resourceIds: ["supplier:s"],
    eligibleResourceIds: ["supplier:s"],
    external: {
      packages: [flow],
      fullReadyAt: null,
      firstBatchReadyAt: from,
      issues: [],
    },
  });
const machine: Resource = { ...supplier, id: "machine:m", kind: "MACHINE" };
describe("retours externes et effets sur la suite", () => {
  it("compte cinq jours ouvrés après le départ en excluant fermeture et week-end", () =>
    expect(
      externalCompletion(
        [{ ...flow, promisedDate: null }],
        100,
        from,
        [supplier],
        from,
      ).fullReadyAt,
    ).toBe("2026-09-22T14:00:00.000Z"));
  it("convertit une promesse à la fin du jour local, y compris aux changements d’heure", () => {
    expect(promiseEnd("2026-03-29", "Europe/Paris")).toBe(
      "2026-03-29T22:00:00.000Z",
    );
    expect(promiseEnd("2026-10-25", "Europe/Paris")).toBe(
      "2026-10-25T23:00:00.000Z",
    );
  });
  it("une promesse dépassée ne devient pas une nouvelle estimation silencieuse", () =>
    expect(
      externalCompletion(
        [{ ...flow, promisedDate: "2026-09-10" }],
        100,
        from,
        [supplier],
        from,
      ),
    ).toMatchObject({
      fullReadyAt: null,
      issues: [expect.stringContaining("nouvelle promesse")],
    }));
  it("une libération qualité manquante empêche de promettre le solde", () =>
    expect(
      externalCompletion(
        [{ ...flow, released: 20 }],
        100,
        from,
        [supplier],
        from,
      ).fullReadyAt,
    ).toBeNull());
  it("un transfert 40/100 ne masque pas le retour du solde quand on déplace seulement la suite", () => {
    const result = schedule({
      tasks: [external(), task("next")],
      resources: [supplier, machine],
      dependencies: [
        {
          predecessorId: "external",
          successorId: "next",
          transferQuantity: 20,
          releasedQuantity: 40,
          lagMinutes: 0,
        },
      ],
      from,
      requested: [{ taskId: "next", earliestStart: from }],
    });
    expect(result.feasible).toBe(true);
    expect(result.forecasts.next.start).toBe("2026-09-24T06:00:00.000Z");
  });
  it("un fournisseur ne monopolise pas une capacité machine", () => {
    const other = external();
    other.id = "other";
    other.external!.packages = [
      { ...flow, packageId: "other", departedAt: null },
    ];
    const first = external();
    first.external!.packages = [{ ...flow, departedAt: null }];
    const result = schedule({
      tasks: [first, other],
      resources: [supplier],
      dependencies: [],
      from,
      requested: [
        { taskId: "external", earliestStart: from },
        { taskId: "other", earliestStart: from },
      ],
    });
    expect(result.feasible).toBe(true);
    expect(result.forecasts.external).toEqual(result.forecasts.other);
  });
});
