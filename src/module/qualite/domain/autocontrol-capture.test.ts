import { describe, expect, it } from "vitest";
import { assertAutocontrolCapture, assertPaperAutocontrolScope, paperAutocontrolVerdict, type AutocontrolCaptureContext } from "./autocontrol-capture";
import { autocontrolCaptureSchema } from "../validators/quality-360.validators";

const context = (): AutocontrolCaptureContext => ({
  ofId: 95, operationId: "operation-a", controlId: "control-a", mode: "PAPER",
  scan: { ofId: 95, operationId: "operation-a", controlId: "control-a", removed: false,
    uploadCommitted: true, antivirusClean: true, mimeType: "application/pdf", bytes: 1000 },
});

describe("Paper summary and exact operation scope", () => {
  const source = { source_type: "OF_OPERATION", source_id: "op", of_id: 95, operation_id: "op", trigger_type: "IN_PROCESS" };
  it.each(["FIRST_ARTICLE", "IN_PROCESS", "FINAL"])("allows a complete paper sheet for %s", trigger_type => {
    expect(assertPaperAutocontrolScope({ ...source, trigger_type })).toEqual({ ofId: 95, operationId: "op" });
  });
  it.each([{ source_type: "RECEPTION_LINE" }, { of_id: null }, { operation_id: "another" }, { trigger_type: "LOT_RELEASE" }])("rejects an unrelated scope %j", patch => {
    expect(() => assertPaperAutocontrolScope({ ...source, ...patch })).toThrow("l’opération de l’OF");
  });
  it.each([[20,20,"CONFORME"],[20,17,"PARTIEL"],[20,0,"NON_CONFORME"]] as const)("preserves %s / %s as %s without invented measures", (population, conforming, verdict) => {
    expect(paperAutocontrolVerdict(population,conforming)).toBe(verdict);
  });
  it.each([[0,0],[20,21],[20,-1],[20,Infinity]])("rejects invalid counts %j", (population,conforming) => {
    expect(() => paperAutocontrolVerdict(population,conforming)).toThrow("quantité conforme");
  });
  it("requires an explicit complete sheet confirmation and rejects client scan authority", () => {
    const input={params:{id:"11111111-1111-4111-8111-111111111111"},body:{mode:"PAPER",expected_updated_at:"2026-10-14T12:00:00Z",document_id:"22222222-2222-4222-8222-222222222222",conforming_qty:20,instruments:[],complete_sheet:true}};
    expect(autocontrolCaptureSchema.safeParse(input).success).toBe(true);
    expect(autocontrolCaptureSchema.safeParse({...input,body:{...input.body,complete_sheet:false}}).success).toBe(false);
    expect(autocontrolCaptureSchema.safeParse({...input,body:{...input.body,antivirusClean:true}}).success).toBe(false);
    expect(autocontrolCaptureSchema.safeParse({...input,body:{mode:"DIGITAL",expected_updated_at:input.body.expected_updated_at}}).success).toBe(true);
  });
});
describe("Autocontrol paper or tablet capture", () => {
  it("requires a scan on the paper path", () => {
    expect(() => assertAutocontrolCapture({ ...context(), scan: null })).toThrow("Joignez la fiche");
  });
  it("accepts the committed scan without measurement retyping and retains the quality decision", () => {
    expect(assertAutocontrolCapture(context())).toEqual({ measurementsRequired: false, scanRequired: true, qualityDecisionRequired: true });
  });
  it("retains digital measurements without requiring a paper scan", () => {
    expect(assertAutocontrolCapture({ ...context(), mode: "DIGITAL", scan: null })).toEqual({ measurementsRequired: true, scanRequired: false, qualityDecisionRequired: true });
  });
  it.each(["ofId", "operationId", "controlId"] as const)("rejects a scan belonging to another %s", (key) => {
    const input = context(); input.scan = { ...input.scan!, [key]: key === "ofId" ? 96 : "another" };
    expect(() => assertAutocontrolCapture(input)).toThrow("cet OF et à cette opération");
  });
  it.each([{ removed: true }, { uploadCommitted: false }, { antivirusClean: false }, { bytes: 0 }])("rejects unavailable proof %j", (patch) => {
    const input = context();input.scan = { ...input.scan!, ...patch };
    expect(() => assertAutocontrolCapture(input)).toThrow("enregistré et vérifié");
  });
  it("rejects an editable spreadsheet in place of the scanned sheet", () => {
    const input = context();input.scan = { ...input.scan!, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    expect(() => assertAutocontrolCapture(input)).toThrow("PDF, JPG ou PNG");
  });
});
