import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildFixtureInput } from "../../test-support/production/of-document.fixture";
import { buildOfDocumentPayload } from "../module/production/domain/of-document";
import { renderWorkshopSupportPaper } from "../module/production/services/workshop-support-paper";

describe("blank preparation and improvement paper companions", () => {
  const payload = buildOfDocumentPayload(buildFixtureInput({ clientNom: "PRIVATE-CUSTOMER-NAME", visas: {} }));
  it("renders all three sheet purposes from the same frozen identity", async () => {
    for (const kind of ["IMPROVEMENT", "PREPARATION_CREATION", "PREPARATION_INDEX"] as const) {
      const bytes = await renderWorkshopSupportPaper(payload, kind), pdf = await PDFDocument.load(bytes);
      expect(pdf.getAuthor()).toBe("Croix Rousse Precision");
      expect(pdf.getTitle()).toContain(payload.ofNumero); expect(pdf.getSubject()).toContain("Fiche vierge");
      expect(pdf.getPageCount()).toBeGreaterThan(0);
    }
  });
  it("keeps the print bytes deterministic and does not copy operation signatures into blank preparation", async () => {
    const first = await renderWorkshopSupportPaper(payload, "PREPARATION_CREATION");
    const signed = { ...payload, phases: payload.phases.map(phase => ({ ...phase, visa: { ...phase.visa, visaOperateur: "SIGNATURE-NOT-FOR-PREPARATION" } })) };
    expect((await renderWorkshopSupportPaper(signed, "PREPARATION_CREATION")).equals(first)).toBe(true);
    expect((await renderWorkshopSupportPaper(payload, "PREPARATION_CREATION")).equals(first)).toBe(true);
  });
});
