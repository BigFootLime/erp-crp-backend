import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildOfDocumentPayload, OF_DOCUMENT_TEMPLATE_VERSION, OF_WORKSHOP_TEMPLATE_VERSION } from "../module/production/domain/of-document";
import { renderOfDocument } from "../module/production/services/of-document-render";
import { buildFixtureInput, FIXTURE_OPERATIONS_TFT } from "../../test-support/production/of-document.fixture";
import { renderCerpDocument } from "../shared/pdf/cerp-document";
import { renderWorkshopTable } from "../shared/pdf/workshop-document-blocks";

function content(bytes: Buffer): string {
  let from = 0, result = "";
  while ((from = bytes.indexOf("stream\n", from)) >= 0) {
    from += 7;
    const end = bytes.indexOf("endstream", from);
    if (end < 0) break;
    try {
      const stream = inflateSync(bytes.subarray(from, end)).toString("latin1");
      result += [...stream.matchAll(/<([a-f0-9\s]+)>/gi)].map(match => Buffer.from(match[1].replace(/\s/g, ""), "hex").toString("latin1")).join("");
    } catch { /* Image streams have no document text. */ }
    from = end + 9;
  }
  return result.replace(/\s/g, "");
}

describe("Workshop OF layout and source boundaries", () => {
  it("keeps the saved 1.5 rendering unchanged", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ templateVersion: "of-ordre-fabrication/1.5" }));
    const result = await renderOfDocument(payload);
    expect(result.sha256).toBe("82940ca701317f2ffb5809ca1dde34901d8c43f34fd90888448cd23afa029fef");
  });
  it("shows the original internal deadline instead of an inapplicable client AR", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ templateVersion: OF_WORKSHOP_TEMPLATE_VERSION,
      commercialScope: "INTERNAL", commandeNumero: null, affaires: [], internalDueDate: "2026-09-30", quantiteLancee: 20 }));
    const text = content((await renderOfDocument(payload)).buffer);
    expect(text).toContain("Délaiinterne");
    expect(text).toContain("30/09/2026");
    expect(text).not.toContain("Délaiclient");
    expect(text).not.toContain("Nonapplicable");
  });
  it("keeps the client AR first and removes redundant header fields", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ templateVersion: OF_WORKSHOP_TEMPLATE_VERSION,
      internalDueDate: "2026-06-20", technicalEvidence: {
        source: { kind: "REVISION_SNAPSHOT", hash: "fixture", technicalVersionId: null },
        materialNotRequired: false, correctionCount: 0, nomenclature: [], documents: [], purchases: [], debits: [],
        materials: [{ needId: null, form: null, reference: "MP-6061", designation: "Aluminium", grade: "6061", condition: "T651",
          dimensions: { longueur_mm: 57 }, requiredQuantity: 2280, debitPerBlank: 57, unit: "mm", phase: 20,
          confirmed: true, certificates: [], manualChecks: [] }],
      } }));
    const text = content((await renderOfDocument(payload)).buffer);
    expect(text).toContain("01/07/2026");
    expect(text.split("Nomenclature")[0]).not.toContain("20/06/2026");
    expect(text).not.toContain("Opérationconsommatrice");
    expect(text.split("Nomenclature")[0]).not.toContain("Gammeapplicable");
    expect(text).toContain("Gammeapplicable-opérations");
  });
  it("keeps a saved 1.4 PDF byte-identical to the deployed renderer", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ templateVersion: "of-ordre-fabrication/1.4" }));
    const result = await renderOfDocument(payload);
    expect(result.sha256).toBe("c7df1ba82bd5dbefd2244280895d91a5b826ff2102184b318d63a9bf8676f8a6");
    expect(result.byteSize).toBe(33610);
    expect(content(result.buffer)).toContain("Éditéle");
  });
  it("prints the generation timestamp only in the footer for new documents", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ templateVersion: OF_WORKSHOP_TEMPLATE_VERSION }));
    const text = content((await renderOfDocument(payload)).buffer);
    expect(text).not.toContain("Éditéle");
    expect(text).toContain("Généré");
  });
  it("uses the launched quantity and the same per-operation rounding as the planner", () => {
    const input = buildFixtureInput({ templateVersion: OF_WORKSHOP_TEMPLATE_VERSION, quantiteLancee: 20,
      operations: [{ ...FIXTURE_OPERATIONS_TFT[0], preparation: 1 / 3, tempsUnitaire: 0.05, quantiteBase: 1 }] });
    const payload = buildOfDocumentPayload(input);
    expect(payload.phases[0].fabricationH).toBe(1);
    expect(payload.phases[0].finalH).toBeCloseTo(80 / 60, 4);
    expect(payload.totaux.finalLabel).toBe("1 h 20 min");
    expect(payload.quantiteLancee).toBe(20);
  });
  it("does not silently opt saved legacy payloads into modern loads or execution counters", () => {
    for (const version of ["of-ordre-fabrication/1.2", OF_DOCUMENT_TEMPLATE_VERSION]) {
      const input = buildFixtureInput({ templateVersion: version, quantiteLancee: 20, operations: [FIXTURE_OPERATIONS_TFT[0]],
        executions: { 10: { statut: "DONE", bonnes: 20, rebuts: 0, attenteControle: 0, reprises: 0 } } });
      const payload = buildOfDocumentPayload(input);
      expect(payload.quantiteLancee).toBeUndefined();
      expect(payload.phases[0].execution).toBeUndefined();
      expect(payload.phases[0].fabricationH).toBe(1);
    }
    expect(buildOfDocumentPayload(buildFixtureInput()).templateVersion).toBe(OF_DOCUMENT_TEMPLATE_VERSION);
  });
  it("prints completed net production without inventing a phase visa or a customer delivery", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ templateVersion: OF_WORKSHOP_TEMPLATE_VERSION, quantiteLancee: 20,
      commandeNumero: null, affaires: [], cadenceLivraison: [], cadenceProduction: [], derniereFabrication: null,
      operations: [{ ...FIXTURE_OPERATIONS_TFT[0], quantiteBase: 1 }], visas: {},
      executions: { 10: { statut: "DONE", bonnes: 20, rebuts: 0, attenteControle: 0, reprises: 0 } } }));
    const text = content((await renderOfDocument(payload)).buffer);
    expect(text).toContain("Production:Terminée");
    expect(text).toContain("20bonnes");
    expect(text).toContain("Visaop.:__________");
    expect(text).not.toContain("ExpédiéeparBL");
    expect(text).not.toContain("Visaop.:AG");
    expect(text).not.toContain(payload.snapshotSha256);
  });
  it("retains every affair even when the overview contains only the first two", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ templateVersion: OF_WORKSHOP_TEMPLATE_VERSION, quantiteLancee: 40,
      affaires: Array.from({ length: 8 }, (_, i) => ({ affaireId: i + 1, numero: `AFF-1285-${i}`, delaiClient: `2026-10-${String(i + 20).padStart(2, "0")}`, quantite: 5 })) }));
    const text = content((await renderOfDocument(payload)).buffer);
    for (let i = 0; i < 8; i++) expect(text).toContain(`AFF-1285-${i}`);
  });
  it("places raw material and the earliest client AR in the first row, ahead of the client/documents panel", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ templateVersion: OF_WORKSHOP_TEMPLATE_VERSION, quantiteLancee: 20,
      affaires: [{ affaireId: 1, numero: "AFF-A", delaiClient: "2026-10-30", quantite: 15 }, { affaireId: 2, numero: "AFF-B", delaiClient: "2026-10-16", quantite: 5 }],
      matiere: { reference: "MP-FIRST-PAGE", designation: "Barre aluminium", nuance: "6061" } }));
    const text = content((await renderOfDocument(payload)).buffer);
    expect(text.indexOf("16/10/2026")).toBeLessThan(text.indexOf("CLIENTETDOCUMENTS"));
    expect(text.indexOf("MP-FIRST-PAGE")).toBeLessThan(text.indexOf("CLIENTETDOCUMENTS"));
    expect(text).toContain("ARleplusproche");
    expect(text).toContain("AFF-A");
    expect(text).toContain("AFF-B");
  });
  it("separates the client code from delivery affairs and excludes the client name", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ templateVersion: OF_WORKSHOP_TEMPLATE_VERSION, clientCode: "CLI-007",
      clientNom: "CLIENT NAME MUST NOT BE PRINTED", affaires: [{ affaireId: 7, numero: "AFF-DELIVERY-007", delaiClient: "2026-10-16", quantite: 20 }] }));
    const text = content((await renderOfDocument(payload)).buffer);
    expect(text).toContain("Codeclient");
    expect(text).toContain("CLI-007");
    expect(text).toContain("Affairedelivraison");
    expect(text).toContain("AFF-DELIVERY-007");
    expect(text).not.toContain("CLIENTNAMEMUSTNOTBEPRINTED");
  });
  it("prints component and treatment nomenclature before the routing, with minutes rather than decimal hours", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ templateVersion: OF_WORKSHOP_TEMPLATE_VERSION, quantiteLancee: 4,
      operations: [{ ...FIXTURE_OPERATIONS_TFT[0], tempsUnitaire: 0.008, preparation: 0.5 }] }));
    payload.technicalEvidence = { source: { kind: "REVISION_SNAPSHOT", hash: "frozen", technicalVersionId: null },
      materials: [], debits: [], documents: [], correctionCount: 0, materialNotRequired: true,
      nomenclature: [{ id: "line", repere: "AXE", reference: "COMP-AXE", indice: "B", designation: "Axe traité", quantityPerParent: 1, requiredQuantity: 4, unit: "pièce" }],
      purchases: [{ type: "TRAITEMENT", designation: "Nitruration", phase: 30, quantityPerPiece: 1, unit: "PCE" }] };
    const text = content((await renderOfDocument(payload)).buffer);
    expect(text.indexOf("Nomenclature")).toBeLessThan(text.indexOf("Gammeapplicable-opérations"));
    expect(text.indexOf("COMP-AXE")).toBeLessThan(text.indexOf("Gammeapplicable-opérations"));
    expect(text.indexOf("Nitruration")).toBeLessThan(text.indexOf("Gammeapplicable-opérations"));
    expect(text).toContain("0,48min");
    expect(text).toContain("30min");
    expect(text).not.toContain("0,008");
  });
  it("paginates an operation longer than a page without dropping its last instruction", async () => {
    const bytes = await renderCerpDocument({ designVersion: "workshop-v3", documentType: "Ordre de fabrication", name: "OF-FICTIF",
      code: "R00", status: "BROUILLON", generatedAt: "13/10/2026", title: "Fixture", subject: "Fixture", creationDate: new Date("2026-10-13T10:00:00Z") }, ctx => {
      renderWorkshopTable(ctx, { title: "Gamme applicable", columns: [{ key: "phase", label: "Phase", flex: 1 }, { key: "text", label: "Opération", flex: 5 }],
        rows: [{ cells: { phase: "10", text: Array.from({ length: 180 }, (_, i) => `Instruction-${i}: conserver le lot et vérifier le plan.`).join("\n") }, continuationLabel: "Phase10-suite" }] });
    });
    const text = content(bytes);
    for (let i = 0; i < 180; i++) expect(text).toContain(`Instruction-${i}:`);
    expect(text).toContain("Phase10-suite");
    const pages = (bytes.toString("latin1").match(/\/Type \/Page\b/g) || []).length;
    expect(pages).toBeGreaterThan(3);
    for (let page = 1; page <= pages; page++) expect(text).toContain(`Page${page}/${pages}`);
  });
});
