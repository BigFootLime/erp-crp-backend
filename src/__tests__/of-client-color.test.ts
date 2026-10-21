import { describe, expect, it } from "vitest";
import { buildOfDocumentPayload, OF_WORKSHOP_TEMPLATE_VERSION } from "../module/production/domain/of-document";
import { ofDocumentSourceFingerprint } from "../module/production/domain/of-document-source-fingerprint";
import { renderOfDocument } from "../module/production/services/of-document-render";
import { buildFixtureInput } from "../../test-support/production/of-document.fixture";
import { PLANNING_CLIENT_PALETTE, planningClientPastel, resolvePlanningClientColor } from "../module/planning/domain/planning-client-color";
import { planningClientColorSchema } from "../module/planning/validators/planning-client-color.validators";

describe("Shared client color on the workshop paper", () => {
  it("keeps the 1.8 archive byte-identical even when an extra color is supplied", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ templateVersion: "of-ordre-fabrication/1.8", clientPlanningColor: "#FCE7F3" }));
    expect(payload.clientPlanningColor).toBeUndefined();
    expect((await renderOfDocument(payload)).sha256).toBe("657de9d013a5b25f4c0e97bb7c771884522431e20d8df4344881a23d5d7343f7");
  });
  it.each(PLANNING_CLIENT_PALETTE)("retains pastel %s exactly in the issued edition", async color => {
    expect(planningClientPastel(color)).toBe(color);
    const payload = buildOfDocumentPayload(buildFixtureInput({ templateVersion: OF_WORKSHOP_TEMPLATE_VERSION, clientPlanningColor: color }));
    expect(payload.clientPlanningColor).toBe(color);
    expect((await renderOfDocument(payload)).buffer.subarray(0, 4).toString()).toBe("%PDF");
  });
  it("detects a shared color change between preview and issue without altering an archive", async () => {
    const old = buildOfDocumentPayload(buildFixtureInput({ templateVersion: OF_WORKSHOP_TEMPLATE_VERSION, clientPlanningColor: "#DBEAFE" }));
    const bytes = await renderOfDocument(old);
    const next = { ...old, clientPlanningColor: "#DCFCE7" };
    expect(ofDocumentSourceFingerprint(next)).not.toBe(ofDocumentSourceFingerprint(old));
    expect((await renderOfDocument(old)).sha256).toBe(bytes.sha256);
  });
  it("uses shared assignments ahead of presets and assigns no customer to internal work", () => {
    expect(resolvePlanningClientColor("003", "CRP", "#FCE7F3")).toBe("#FCE7F3");
    expect(resolvePlanningClientColor(null, null)).toBeNull();
    expect(resolvePlanningClientColor("003", "Example")).toBe(resolvePlanningClientColor("003", "Renamed"));
  });
  it("normalizes dark colors to pastel, and rejects alert red or invalid input", () => {
    expect(planningClientPastel("#2563eb")).toBe("#CCDBFA");
    for (const color of ["#FF0000", "#ffcccc", "red", "url(secret)", "#ZZZZZZ"]) {
      expect(planningClientColorSchema.safeParse({ params: { clientId: "003" }, body: { color } }).success).toBe(false);
    }
    expect(planningClientColorSchema.parse({ params: { clientId: "003" }, body: { color: null } }).body.color).toBeNull();
  });
});
