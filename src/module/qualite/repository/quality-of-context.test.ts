import { beforeEach, describe, expect, it, vi } from "vitest";
const readiness = vi.hoisted(() => ({ enabled: vi.fn(), read: vi.fn() }));
vi.mock("../../production/repository/operation-readiness.repository", () => ({ usesOperationReadiness: readiness.enabled, readOperationReadinessTx: readiness.read }));
import { qualityOfPopulationCeiling, readFrozenQualityPlanId, resolveQualityOfContext, type QualityOfIdentity } from "./quality-of-context";
import { executionPreviewSchema, ofOperationExecutionContextSchema, type ExecutionPreviewBodyDTO } from "../validators/quality-360.validators";

const opId = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const identity: QualityOfIdentity = { id: 103, numero: "OF-2026-001267", status: "EN_COURS", population: 4, unit: "u", article_id: other, piece_id: other, version_id: other, famille_id: null, snapshot_sha256: "a".repeat(64), operation_id: opId, phase: 30, label: "Contrôle final", operation_status: "RUNNING" };
const body: ExecutionPreviewBodyDTO = { source_type: "OF_OPERATION", source_id: opId, of_id: 103, trigger: "FINAL", population: 4, unite: "u" };
function db(row = identity) { return { query: vi.fn(async (_sql: string) => ({ rows: [row] })) }; }
beforeEach(() => { readiness.enabled.mockReset().mockResolvedValue(true); readiness.read.mockReset().mockResolvedValue({ operations: [{ id: opId, availableQuantity: 4, processedQuantity: 0 }] }); });

describe("Authoritative OF operation quality context", () => {
  it("prefills the actual OF identities and persists its operation scope under locks", async () => {
    const q = db();
    const result = await resolveQualityOfContext(q as never, { ...body, preview_sha256: "b".repeat(64), comments: "Fictif" }, true);
    expect(result).toMatchObject({ article_id: other, piece_technique_id: other, piece_version_id: other, operation_id: opId, operation_code: "30", population: 4, comments: "Fictif" });
    expect(q.query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining([expect.stringContaining("ordres_fabrication WHERE id=$1 FOR UPDATE"), expect.stringContaining("of_operations WHERE id=$1::uuid FOR UPDATE")]));
  });
  it.each([
    [{ operation_id: other }, "QUALITY_OF_OPERATION_MISMATCH"],
    [{ piece_version_id: opId }, "QUALITY_OF_SCOPE_CHANGED"],
    [{ article_id: opId }, "QUALITY_OF_SCOPE_CHANGED"],
    [{ operation_code: "40" }, "QUALITY_OF_SCOPE_CHANGED"],
    [{ unite: "mm" }, "QUALITY_OF_UNIT_MISMATCH"],
    [{ population: 5 }, "QUALITY_OF_POPULATION_UNAVAILABLE"],
    [{ lot_id: opId }, "QUALITY_OF_SCOPE_INVALID"],
    [{ reception_ligne_id: opId }, "QUALITY_OF_SCOPE_INVALID"],
    [{ source_id: "not-an-operation" }, "QUALITY_OF_OPERATION_INVALID"],
  ])("rejects an altered context %o", async (patch, code) => {
    await expect(resolveQualityOfContext(db() as never, { ...body, ...patch })).rejects.toMatchObject({ code });
  });
  it("rejects an operation owned by another OF instead of recording a loose foreign key", async () => {
    await expect(resolveQualityOfContext(db({ ...identity, operation_id: null }) as never, body)).rejects.toMatchObject({ code: "QUALITY_OF_OPERATION_MISMATCH" });
  });
  it("rejects cancelled and unfrozen dossiers", async () => {
    await expect(resolveQualityOfContext(db({ ...identity, status: "ANNULE" }) as never, body)).rejects.toMatchObject({ code: "QUALITY_OF_CANCELLED" });
    await expect(resolveQualityOfContext(db({ ...identity, snapshot_sha256: null }) as never, body)).rejects.toMatchObject({ code: "QUALITY_OF_NOT_FROZEN" });
  });
  it("allows only the physically available partial batch", async () => {
    readiness.read.mockResolvedValue({ operations: [{ id: opId, availableQuantity: 2, processedQuantity: 0 }] });
    await expect(resolveQualityOfContext(db() as never, body)).rejects.toMatchObject({ code: "QUALITY_OF_POPULATION_UNAVAILABLE", details: { population: 2 } });
    expect(await resolveQualityOfContext(db() as never, { ...body, population: 2 })).toMatchObject({ population: 2 });
  });
  it("retains the physical ceiling for repeat checks after a declaration", async () => {
    readiness.read.mockResolvedValue({ operations: [{ id: opId, availableQuantity: 0, processedQuantity: 4 }] });
    expect(await resolveQualityOfContext(db() as never, body)).toMatchObject({ population: 4 });
  });
  it("derives missing of_id from the source operation and leaves unrelated sources intact", async () => {
    const q = { query: vi.fn().mockResolvedValueOnce({ rows: [{ of_id: 103 }] }).mockResolvedValueOnce({ rows: [identity] }) };
    expect(await resolveQualityOfContext(q as never, { ...body, of_id: null })).toMatchObject({ of_id: 103, operation_id: opId });
    const lot = { ...body, source_type: "LOT" as const, source_id: other, of_id: null };
    expect(await resolveQualityOfContext(q as never, lot)).toBe(lot);
  });
  it("does not select a latest published plan and requires READY provenance for a late attachment", async () => {
    const q = { query: vi.fn().mockResolvedValue({ rows: [{ plan_id: other }] }) };
    expect(await readFrozenQualityPlanId(q as never, 103, opId, "FINAL")).toBe(other);
    const [sql, args] = q.query.mock.calls[0]!;
    expect(args).toEqual([103, "FINAL", opId]);
    expect(sql).toContain("execution_quality"); expect(sql).toContain("s.state='READY'");
    expect(sql).toContain("s.quality_plan_id::text"); expect(sql).not.toContain("published_at DESC");
  });
  it("uses the legacy physical predecessor ceiling without requiring the modern workbench", async () => {
    readiness.enabled.mockResolvedValue(false);
    expect(await qualityOfPopulationCeiling({ query: async () => ({ rows: [{ population: 2 }] }) } as never, identity)).toBe(2);
  });
  it("validates the new route parameters and optional operation UUID strictly", () => {
    expect(ofOperationExecutionContextSchema.parse({ params: { ofId: "103", operationId: opId } }).params.ofId).toBe(103);
    expect(() => ofOperationExecutionContextSchema.parse({ params: { ofId: "103junk", operationId: opId } })).toThrow();
    expect(() => ofOperationExecutionContextSchema.parse({ params: { ofId: "103", operationId: "not-uuid" } })).toThrow();
    expect(() => executionPreviewSchema.parse({ body: { ...body, operation_id: "invalid" } })).toThrow();
  });
});
