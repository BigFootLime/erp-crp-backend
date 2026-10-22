import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CutoverRow } from "../../types/data-cutover.types";
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), targets: vi.fn(), inspect: vi.fn(), validate: vi.fn(), resume: vi.fn(), bind: vi.fn(), resolve: vi.fn() }));
vi.mock("./wip-preparation.contract", () => ({ prepareNativeWipInputTx: mocks.prepare }));
vi.mock("../../../production/wip-opening/wip-opening.repository", () => ({ assertWipResumeTargetsTx: mocks.targets, resumeWipOpeningTx: mocks.resume }));
vi.mock("../../../production/wip-material-opening/wip-material-opening.repository", () => ({ inspectWipMaterialDeclarationTx: mocks.inspect, validateWipMaterialOpeningTx: mocks.validate, resumeWipOpeningTx: mocks.resume, bindWipMaterialOpeningTx: mocks.bind, resolveWipMaterialCheckpointTx: mocks.resolve }));
import { inspectNativeWipPreparationTx, resumeNativeWipPreparationTx } from "./wip-native.adapter";

const tx = { query: vi.fn() } as never;
const prepared = { batchId: "batch", rowId: "row", actorId: 1, articleId: "article", pieceTechniqueId: "piece", historicalVersionId: "version", quantityLaunched: 50, physicalBatchReference: "LOT-PHYSIQUE", affair: { type: "COMMANDE_CLIENT", id: "100" } };
const params = { row: { values: { materialOpening: JSON.stringify({ materialState: "NONE_CONSUMED", requirements: [] }) } } as unknown as CutoverRow, article: { id: "article", type: "ARTICLE", reference: "ARTICLE-TEST" }, affair: { id: "100", type: "COMMANDE_CLIENT", reference: "CMD-TEST" }, actorId: 1, sourceSystem: "CLIPPER_EXCEL", operationKey: "operation-test", openingStateId: "opening" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.prepare.mockResolvedValue(prepared);
  mocks.targets.mockResolvedValue(undefined);
  mocks.inspect.mockResolvedValue({ requiresMaterial: false });
  mocks.validate.mockResolvedValue({ requiresMaterial: false, checkpointId: null });
  mocks.resume.mockResolvedValue({ ofId: 123, ofReference: "OF-TEST", resumptionId: "resume", operationIdsByPhase: {} });
  mocks.bind.mockResolvedValue({ checkpointId: "", ofId: 123, boundNeedIds: [] });
});

describe("native WIP application transaction boundary", () => {
  it("preview checks the native demand and material without writing a checkpoint or OF", async () => {
    await inspectNativeWipPreparationTx(tx, params);
    expect(mocks.targets).toHaveBeenCalledWith(tx, prepared);
    expect(mocks.inspect).toHaveBeenCalledWith(tx, expect.objectContaining({ quantityLaunched: 50, materialState: "NONE_CONSUMED" }));
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
  });
  it("keeps material validation, creation and binding on the caller transaction in that order", async () => {
    await expect(resumeNativeWipPreparationTx(tx, params)).resolves.toMatchObject({ ofId: 123 });
    expect(mocks.validate).toHaveBeenCalledWith(tx, expect.objectContaining({ openingStateId: "opening" }));
    expect(mocks.resume).toHaveBeenCalledWith(tx, expect.objectContaining({ materialScope: "NONE", materialCheckpointId: null }), { resolveMaterialCheckpoint: mocks.resolve });
    expect(mocks.bind).toHaveBeenCalledWith(tx, expect.objectContaining({ materialScope: "NONE" }), 123);
    expect(mocks.validate.mock.invocationCallOrder[0]).toBeLessThan(mocks.resume.mock.invocationCallOrder[0]);
    expect(mocks.resume.mock.invocationCallOrder[0]).toBeLessThan(mocks.bind.mock.invocationCallOrder[0]);
  });
  it("takes the actual checkpoint only from server validation", async () => {
    mocks.validate.mockResolvedValue({ requiresMaterial: true, checkpointId: "server-checked-id" });
    await resumeNativeWipPreparationTx(tx, params);
    expect(mocks.resume).toHaveBeenCalledWith(tx, expect.objectContaining({ materialScope: "SINGLE_BATCH_VALIDATED", materialCheckpointId: "server-checked-id" }), expect.anything());
  });
  it("does not create an OF when the material proof is rejected", async () => {
    mocks.validate.mockRejectedValue(new Error("material invalid"));
    await expect(resumeNativeWipPreparationTx(tx, params)).rejects.toThrow("material invalid");
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
  });
  it("propagates a bind failure so the caller rolls back the whole operation", async () => {
    mocks.bind.mockRejectedValue(new Error("binding invalid"));
    await expect(resumeNativeWipPreparationTx(tx, params)).rejects.toThrow("binding invalid");
  });
});
