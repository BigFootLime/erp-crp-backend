import { describe, expect, it } from "vitest";
import { resolveOfDocumentTechnicalSource, ofDocumentComponent, ofDocumentExecution, ofDocumentModernDebit, ofDocumentTechnicalIdentity } from "../module/production/domain/of-document-technical-source";
import { ofDocumentSourceFingerprint } from "../module/production/domain/of-document-source-fingerprint";
import { formatWorkshopDuration } from "../shared/pdf/workshop-duration";
import { buildOfDocumentPayload, OF_WORKSHOP_TEMPLATE_VERSION } from "../module/production/domain/of-document";
import { buildFixtureInput } from "../../test-support/production/of-document.fixture";

const version = "8f1b15b4-9b5c-48ef-95d9-9cf37db6d997";
const root = { piece: { code: "PT-FROZEN", designation: "Dossier figé" }, version: { id: version, indice_externe: "B" } };
const source = (status: string, revisionSnapshot: unknown = { of_id: 95, origin: "seed" }) => resolveOfDocumentTechnicalSource({
  revisionStatus: status, revisionHash: "revision-hash", revisionSnapshot, rootHash: "root-hash", rootSnapshot: root,
});

describe("Authoritative workshop source", () => {
  it("uses the active frozen dossier for a seed revision without borrowing it for an obsolete revision", () => {
    expect(source("ACTIVE").kind).toBe("ACTIVE_TECHNICAL_SNAPSHOT");
    expect(source("ACTIVE").technicalVersionId).toBe(version);
    expect(source("OBSOLETE").snapshot).toEqual({ of_id: 95, origin: "seed" });
    expect(source("OBSOLETE").technicalVersionId).toBeNull();
  });
  it("retains a complete revision's own dossier rather than the current root", () => {
    const frozen = { ...root, piece: { code: "PT-OLD", designation: "Ancienne pièce" } };
    expect(source("OBSOLETE", frozen).kind).toBe("REVISION_SNAPSHOT");
    expect(ofDocumentTechnicalIdentity(source("OBSOLETE", frozen)).pieceReference).toBe("PT-OLD");
  });
  it("does not send a malformed legacy version identifier to a UUID SQL cast", () => {
    const invalid = { ...root, version: { id: "1" } };
    expect(resolveOfDocumentTechnicalSource({ revisionStatus: "ACTIVE", revisionHash: "x", revisionSnapshot: invalid,
      rootHash: "x", rootSnapshot: invalid }).technicalVersionId).toBeNull();
  });
  it("recovers readable identity from an old flat revision without a current PT fallback", () => {
    const identity = ofDocumentTechnicalIdentity(source("OBSOLETE", { pieceReference: "OLD-REF", pieceIndice: "C", pieceDesignation: "Ancien dossier" }));
    expect(identity).toMatchObject({ pieceReference: "OLD-REF", pieceIndice: "C", pieceDesignation: "Ancien dossier" });
  });
  it("calculates component demand from the frozen per-parent quantity, preserving a missing reference", () => {
    expect(ofDocumentComponent({ id: "line", repere: "AXE", quantite: 1.5, child_piece_technique_id: version }, 4))
      .toMatchObject({ reference: null, repere: "AXE", quantityPerParent: 1.5, requiredQuantity: 6, unit: "pièce" });
    expect(ofDocumentComponent({ id: "line", quantite: null }, 4).requiredQuantity).toBeNull();
  });
  it("never equates a stock debit step with physical blank length or an implicit yield", () => {
    const debit = ofDocumentModernDebit([{ needId: "n", reference: "MP", designation: "Barre", phase: 10, requiredQuantity: 2210,
      unit: "mm", grade: "42CRMO4", condition: "BRUT", dimensions: {}, certificates: [], manualChecks: [],
      debitPerBlank: 110.5, form: "BAR", confirmed: true }]);
    expect(debit.longueurTotaleMm).toBe(2210);
    expect(debit.longueurBrutMm).toBeUndefined();
    expect(debit.piecesParBrut).toBeUndefined();
  });
  it("keeps execution counters separate from signatures and refuses invalid counters", () => {
    const execution = ofDocumentExecution({ status: "DONE", good: 20, scrap: 1, pending: 0, rework: 0 });
    expect(execution).toEqual({ statut: "DONE", bonnes: 20, rebuts: 1, attenteControle: 0, reprises: 0 });
    expect(() => ofDocumentExecution({ status: "DONE", good: -1, scrap: 0, pending: 0, rework: 0 })).toThrow();
  });
  it("checks the facts approved in the preview while ignoring edition presentation metadata", () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ templateVersion: OF_WORKSHOP_TEMPLATE_VERSION, quantiteLancee: 20 }));
    const fingerprint = ofDocumentSourceFingerprint(payload);
    expect(ofDocumentSourceFingerprint({ ...payload, generatedAt: "2030-01-01", auteur: "Autre", documentStatut: "OFFICIEL", watermark: null })).toBe(fingerprint);
    expect(ofDocumentSourceFingerprint({ ...payload, quantiteLancee: 21 })).not.toBe(fingerprint);
    expect(ofDocumentSourceFingerprint({ ...payload, quantites: { ...payload.quantites, quantiteLivree: 4 } })).not.toBe(fingerprint);
  });
});

it.each([[0.008, "0,48 min"], [0.1, "6 min"], [0.5, "30 min"], [1, "1 h"], [1.5, "1 h 30 min"], [0, "0 min"], [0.000001, "< 0,001 min"]])(
  "prints %s stored hours in workshop units: %s", (input, output) => expect(formatWorkshopDuration(input)).toBe(output),
);
