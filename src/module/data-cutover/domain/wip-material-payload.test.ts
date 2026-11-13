import { describe, expect, it } from "vitest";
import { parseWipMaterialPayload } from "./wip-material-payload";

const line = { technicalPurchaseId: "b99b1627-18a1-44c0-99b0-83ef5f31c2e1", articleId: "b99b1627-18a1-44c0-99b0-83ef5f31c2e2", unit: "kg", quantityConsumed: 0, evidenceReference: "Fiche atelier datée" };
const consumed = { ...line, quantityConsumed: 2, historicalTraceReference: "LOT-ANCIEN", qualityStatus: "LIBERE", qualityEvidenceReference: "Visa qualité", certificateReference: "CERT-1", heatReference: "COULEE-1", materialCategory: "Nuance confirmée" };
const payload = (requirement: object, materialState = "NONE_CONSUMED") => JSON.stringify({ materialState, requirements: [requirement] });

describe("bounded guided material declaration", () => {
  it("keeps an explicitly unconsumed future requirement without inventing a lot", () => {
    expect(parseWipMaterialPayload(payload(line))).toEqual({ materialState: "NONE_CONSUMED", requirements: [line] });
  });
  it("accepts documented historical material without creating native stock", () => {
    expect(parseWipMaterialPayload(payload(consumed, "ALL_ALREADY_CONSUMED")).requirements[0]).toEqual(consumed);
  });
  it("accepts 1.001 without float rejection and refuses a genuine fifth decimal", () => {
    expect(parseWipMaterialPayload(payload({ ...consumed, quantityConsumed: 1.001 }, "PARTIAL")).requirements[0].quantityConsumed).toBe(1.001);
    expect(() => parseWipMaterialPayload(payload({ ...consumed, quantityConsumed: 1.00001 }, "PARTIAL"))).toThrow();
  });
  it.each([
    [{ ...line, quantityConsumed: null }, "NONE_CONSUMED"],
    [{ ...line, quantityConsumed: "2" }, "PARTIAL"],
    [{ ...line, quantityConsumed: 0.00001 }, "PARTIAL"],
    [{ ...line, evidenceReference: "<script>bad</script>" }, "NONE_CONSUMED"],
    [{ ...consumed, qualityStatus: "BLOQUE" }, "ALL_ALREADY_CONSUMED"],
    [{ ...consumed, certificateReference: "" }, "ALL_ALREADY_CONSUMED"],
    [{ ...consumed, qualityEvidenceReference: "" }, "ALL_ALREADY_CONSUMED"],
    [{ ...consumed, heatReference: "" }, "ALL_ALREADY_CONSUMED"],
    [{ ...consumed, historicalTraceReference: null }, "ALL_ALREADY_CONSUMED"],
    [{ ...consumed }, "NONE_CONSUMED"],
    [{ ...line, sql: "DROP TABLE" }, "NONE_CONSUMED"],
  ])("refuses incomplete or forged declaration %j", (requirement, state) => {
    expect(() => parseWipMaterialPayload(payload(requirement, state))).toThrowError(expect.objectContaining({ code: "CUTOVER_WIP_MATERIAL_INVALID" }));
  });
  it("rejects duplicate requirements and an oversized serialized payload", () => {
    expect(() => parseWipMaterialPayload(JSON.stringify({ materialState: "NONE_CONSUMED", requirements: [line, line] }))).toThrow();
    expect(() => parseWipMaterialPayload(" ".repeat(8001))).toThrow();
  });
});
