import { describe, expect, it } from "vitest";
import { assertWipOpeningTechnicalSnapshot, assertWipOpeningInput, assertWipResumeTargetsTx } from "./wip-opening.repository";
import { readWipOpeningCheckpointsTx } from "./wip-opening-read.repository";
import type { WipOpeningInput } from "./wip-opening.types";

const input = (): WipOpeningInput => ({
  openingStateId: "11111111-1111-4111-8111-111111111111",
  batchId: "22222222-2222-4222-8222-222222222222",
  rowId: "33333333-3333-4333-8333-333333333333",
  sourceSystem: "CLIPPER_EXCEL",
  operationKey: "wip-pilot-1",
  articleId: "44444444-4444-4444-8444-444444444444",
  affair: { type: "COMMANDE_CLIENT", id: "42", commandLineId: "43", deliveryAffairId: "44" },
  pieceTechniqueId: "55555555-5555-4555-8555-555555555555",
  historicalVersionId: "66666666-6666-4666-8666-666666666666",
  quantityLaunched: 5,
  unit: "u",
  historicalInitialQuantity: 10,
  physicalBatchReference: "LOT-ATELIER-01",
  materialScope: "SINGLE_BATCH_VALIDATED",
  materialCheckpointId: "77777777-7777-4777-8777-777777777777",
  materialEvidenceReference: "GED-WIP-01",
  actorId: 1,
  checkpoints: [
    { phase: 10, status: "COMPLETED", quantityGood: 5, quantityScrap: 0, quantityPendingControl: 0, evidenceReference: "GED-PH10" },
    { phase: 20, status: "IN_PROGRESS", quantityGood: 2, quantityScrap: 0, quantityPendingControl: 0, evidenceReference: "GED-PH20" },
    { phase: 30, status: "NOT_STARTED", quantityGood: 0, quantityScrap: 0, quantityPendingControl: 0, evidenceReference: "GED-PH30" },
  ],
});

function expectCode(action: () => unknown, code: string) {
  try { action(); } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected ${code}`);
}

describe("cutover WIP opening contract", () => {
  it("accepts one homogeneous physical cohort with an explicit material checkpoint", () => {
    expect(() => assertWipOpeningInput(input())).not.toThrow();
  });

  it("refuses a mixed cohort with two concurrently active phases", () => {
    const value = input();
    value.checkpoints[2] = { ...value.checkpoints[2], status: "IN_PROGRESS", quantityGood: 1 };
    expectCode(() => assertWipOpeningInput(value), "CUTOVER_WIP_SPLIT_REQUIRED");
  });

  it("refuses an opening checkpoint that exceeds the unfinished cohort", () => {
    const value = input();
    value.checkpoints[1] = { ...value.checkpoints[1], quantityGood: 6 };
    expectCode(() => assertWipOpeningInput(value), "CUTOVER_WIP_CHECKPOINT_EXCEEDS_COHORT");
  });

  it("permits an evidenced in-progress setup before any physical quantity exists", () => {
    const value = input();
    value.checkpoints[1] = {
      ...value.checkpoints[1],
      quantityGood: 0,
      quantityScrap: 0,
      quantityPendingControl: 0,
      evidenceReference: "Réglage machine confirmé à la bascule",
    };
    expect(() => assertWipOpeningInput(value)).not.toThrow();
  });

  it("refuses a quantity that cannot fit the append-only opening schema", () => {
    const value = input();
    value.quantityLaunched = 10_000_000_000;
    value.historicalInitialQuantity = 10_000_000_000;
    expectCode(() => assertWipOpeningInput(value), "CUTOVER_WIP_QUANTITY_INVALID");
  });

  it("accepts an IEEE decimal with three places and refuses a fifth place", () => {
    const accepted = input();
    accepted.quantityLaunched = 1.001;
    accepted.historicalInitialQuantity = 1.001;
    accepted.checkpoints = accepted.checkpoints.map((point) => ({ ...point, quantityGood: point.quantityGood ? 1.001 : 0 }));
    expect(() => assertWipOpeningInput(accepted)).not.toThrow();
    const refused = input();
    refused.quantityLaunched = 1.00001;
    refused.historicalInitialQuantity = 1.00001;
    expectCode(() => assertWipOpeningInput(refused), "CUTOVER_WIP_QUANTITY_INVALID");
  });

  it("does not make a source code into a native order identifier", () => {
    const value = input();
    value.affair.id = "AFF-26-24000";
    expectCode(() => assertWipOpeningInput(value), "CUTOVER_WIP_AFFAIR_INVALID");
  });

  it("refuses a WIP resume beside an existing ordinary root OF", async () => {
    const query = async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("COALESCE(allocation.qty_remaining")) return { rows: [{ order_type: "FERME", qty_remaining: 5, qty_already_resumed: 0, affair_reference: "AFF-1" }] };
      if (sql.includes("LEFT JOIN public.data_cutover_wip_resumptions resume")) return { rows: [{ id: "71", numero: "OF-2026-000071" }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    };
    await expect(assertWipResumeTargetsTx({ query } as never, {
      affair: { type: "COMMANDE_CLIENT", id: "7", commandLineId: "8", deliveryAffairId: "9" },
      articleId: input().articleId, pieceTechniqueId: input().pieceTechniqueId, historicalVersionId: input().historicalVersionId,
      quantityLaunched: 1, physicalBatchReference: "BATCH-NORMAL-OF",
    })).rejects.toMatchObject({ code: "CUTOVER_WIP_NORMAL_OF_EXISTS", details: { ordinary_of_references: ["OF-2026-000071"] } });
  });

  it("requires a resolved native command line and delivery affair", () => {
    const missingLine = input();
    missingLine.affair.commandLineId = null;
    expectCode(() => assertWipOpeningInput(missingLine), "CUTOVER_WIP_AFFAIR_INVALID");
    const missingAffair = input();
    missingAffair.affair.deliveryAffairId = null;
    expectCode(() => assertWipOpeningInput(missingAffair), "CUTOVER_WIP_AFFAIR_INVALID");
  });

  it("leaves a component-bearing assembly in preparation until a component checkpoint exists", () => {
    expectCode(() => assertWipOpeningTechnicalSnapshot({ version: { manufacturing_mode: "ASSEMBLY" }, nomenclature: [{ id: "component" }] }), "CUTOVER_WIP_ASSEMBLY_COMPONENT_CHECKPOINT_REQUIRED");
    expect(() => assertWipOpeningTechnicalSnapshot({ version: { manufacturing_mode: "ASSEMBLY" }, nomenclature: [] })).not.toThrow();
  });
});

describe("cutover WIP opening read model", () => {
  it("labels opening quantities as CUTOVER_OPENING instead of an operator declaration", async () => {
    const query = async (sql: string) => {
      if (sql.includes("to_regclass")) return { rows: [{ installed: true }] };
      return { rows: [{ operation_id: "op-1", phase: 10, status: "COMPLETED", quantity_good: 3, quantity_scrap: 1, quantity_pending_control: 0, unit: "u" }] };
    };
    await expect(readWipOpeningCheckpointsTx({ query } as never, 42)).resolves.toEqual([
      { operationId: "op-1", phase: 10, status: "COMPLETED", quantityGood: 3, quantityScrap: 1, quantityPendingControl: 0, unit: "u", origin: "CUTOVER_OPENING" },
    ]);
  });
});
