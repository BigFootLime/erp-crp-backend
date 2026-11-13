import { describe, expect, it } from "vitest";
import { inspectWipMaterialDeclarationTx, prepareWipMaterialOpeningTx, readWipMaterialOpeningProjectionTx } from "./wip-material-opening.repository";
import type { WipMaterialOpeningInput } from "./wip-material-opening.types";

const input = (): WipMaterialOpeningInput => ({
  openingStateId: "11111111-1111-4111-8111-111111111111",
  batchId: "22222222-2222-4222-8222-222222222222",
  rowId: "33333333-3333-4333-8333-333333333333",
  articleId: "44444444-4444-4444-8444-444444444444",
  pieceTechniqueId: "55555555-5555-4555-8555-555555555555",
  historicalVersionId: "66666666-6666-4666-8666-666666666666",
  physicalBatchReference: "LOT-ATELIER-01",
  quantityLaunched: 5,
  materialState: "NONE_CONSUMED",
  actorId: 1,
  requirements: [{
    technicalPurchaseId: "77777777-7777-4777-8777-777777777777",
    articleId: "88888888-8888-4888-8888-888888888888",
    unit: "u",
    quantityConsumed: 0,
    evidenceReference: "GED-WIP-MAT-01",
  }],
});

function preparedTx() {
  return {
    query: async (sql: string) => {
      if (sql.includes("data_cutover_opening_states")) return { rows: [{ id: "opening" }] };
      if (sql.includes("piece_technique_versions")) return { rows: [{ id: "version" }] };
      if (sql.includes("pieces_techniques_achats")) return { rows: [{
        id: "77777777-7777-4777-8777-777777777777", article_id: "88888888-8888-4888-8888-888888888888",
        article_code: "MAT-01", purchase_unit: "u", stock_unit: "u", quantity: 2, quantity_pieces: null,
        designation: "Matière pilote", phase: 10, expected_owner_client_id: null,
      }] };
      throw new Error(`Unexpected query ${sql}`);
    },
  };
}

describe("cutover WIP material opening", () => {
  it("keeps a future material requirement at zero without inventing a stock debit", async () => {
    const prepared = await prepareWipMaterialOpeningTx(preparedTx() as never, input());
    expect(prepared).toMatchObject({ requiresMaterial: true, expectedRequirements: [{ requiredQuantity: 10, articleCode: "MAT-01", phase: 10 }] });
  });

  it("accepts a representable four-decimal cohort but rejects a fifth decimal", async () => {
    const accepted = input();
    accepted.quantityLaunched = 1.001;
    await expect(prepareWipMaterialOpeningTx(preparedTx() as never, accepted)).resolves.toMatchObject({ requiresMaterial: true });
    const rejected = input();
    rejected.quantityLaunched = 1.00001;
    await expect(prepareWipMaterialOpeningTx(preparedTx() as never, rejected)).rejects.toMatchObject({ code: "CUTOVER_WIP_MATERIAL_QUANTITY_INVALID" });
  });

  it("inspects a declaration before an opening state exists", async () => {
    const value = input();
    const inspected = await inspectWipMaterialDeclarationTx({ query: async (sql: string) => {
      if (sql.includes("piece_technique_versions")) return { rows: [{ id: "version" }] };
      if (sql.includes("pieces_techniques_achats")) return { rows: [{
        id: value.requirements[0].technicalPurchaseId, article_id: value.requirements[0].articleId, article_code: "MAT-01",
        purchase_unit: "u", stock_unit: "u", quantity: 2, quantity_pieces: null, designation: "Matière pilote", phase: 10, expected_owner_client_id: null,
      }] };
      throw new Error(`Preview must not look up opening state: ${sql}`);
    }} as never, { ...value, openingStateId: undefined, batchId: undefined, rowId: undefined, actorId: undefined } as never);
    expect(inspected.requiresMaterial).toBe(true);
  });

  it("requires a real lot or complete historical quality trace for consumed legacy material", async () => {
    const value = input();
    value.materialState = "PARTIAL";
    value.requirements[0].quantityConsumed = 1;
    await expect(prepareWipMaterialOpeningTx(preparedTx() as never, value)).rejects.toMatchObject({ code: "CUTOVER_WIP_MATERIAL_TRACE_REQUIRED" });
  });

  it("accepts a fully evidenced historical trace when no later reservation is needed", async () => {
    const value = input();
    value.materialState = "ALL_ALREADY_CONSUMED";
    Object.assign(value.requirements[0], {
      quantityConsumed: 10, historicalTraceReference: "CLIPPER-LOT-701", qualityStatus: "LIBERE",
      qualityEvidenceReference: "GED-Q-701", certificateReference: "CERT-3.1-701", heatReference: "COULEE-701", materialCategory: "BARRE",
    });
    await expect(prepareWipMaterialOpeningTx(preparedTx() as never, value)).resolves.toMatchObject({ requiresMaterial: true });
  });

  it("blocks a paper-only partial opening before it creates an OF that cannot reserve its remainder", async () => {
    const value = input();
    value.materialState = "PARTIAL";
    Object.assign(value.requirements[0], {
      quantityConsumed: 1, historicalTraceReference: "CLIPPER-LOT-701", qualityStatus: "LIBERE",
      qualityEvidenceReference: "GED-Q-701", certificateReference: "CERT-3.1-701", heatReference: "COULEE-701", materialCategory: "BARRE",
    });
    await expect(prepareWipMaterialOpeningTx(preparedTx() as never, value)).rejects.toMatchObject({ code: "CUTOVER_WIP_MATERIAL_PARTIAL_TRACE_BLOCKED" });
  });

  it("rejects a unit mismatch instead of guessing a conversion", async () => {
    const value = input();
    value.requirements[0].unit = "kg";
    await expect(prepareWipMaterialOpeningTx(preparedTx() as never, value)).rejects.toMatchObject({ code: "CUTOVER_WIP_MATERIAL_REQUIREMENT_CHANGED" });
  });

  it("labels opening consumption explicitly and returns no facts before the migration", async () => {
    const absent = await readWipMaterialOpeningProjectionTx({ query: async () => ({ rows: [{ installed: false }] }) } as never, 42);
    expect(absent).toEqual([]);
    const facts = await readWipMaterialOpeningProjectionTx({ query: async (sql: string) => sql.includes("to_regclass")
      ? { rows: [{ installed: true }] }
      : { rows: [{ need_id: "need", consumed: 3, checkpoint_id: "checkpoint" }] } } as never, 42);
    expect(facts).toEqual([{ needId: "need", consumed: 3, checkpointId: "checkpoint", origin: "CUTOVER_OPENING" }]);
  });
});
