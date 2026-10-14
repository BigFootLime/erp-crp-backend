import { HttpError } from "../../../utils/httpError";
import type { QualityVerdict } from "./quality-policy";

export type AutocontrolCaptureMode = "PAPER" | "DIGITAL";

export function assertPaperAutocontrolScope(source: {
  source_type: string | null; source_id: string | null;
  of_id: number | null; operation_id: string | null; trigger_type: string | null;
}) {
  if (source.source_type !== "OF_OPERATION" || !source.of_id || !source.operation_id
    || source.source_id !== source.operation_id
    || !["FIRST_ARTICLE", "IN_PROCESS", "FINAL"].includes(source.trigger_type ?? "")) {
    throw new HttpError(422, "AUTOCONTROL_OPERATION_REQUIRED", "Ouvrez l’autocontrôle depuis l’opération de l’OF.");
  }
  return { ofId: source.of_id, operationId: source.operation_id };
}

/** The operator confirms the result on the complete sheet, never invented measures. */
export function paperAutocontrolVerdict(population: number, conforming: number): QualityVerdict {
  if (!Number.isFinite(population) || population <= 0 || !Number.isFinite(conforming)
    || conforming < 0 || conforming > population) {
    throw new HttpError(422, "AUTOCONTROL_QUANTITY_INVALID", "La quantité conforme doit être comprise entre zéro et la quantité contrôlée.");
  }
  return conforming === population ? "CONFORME" : conforming === 0 ? "NON_CONFORME" : "PARTIEL";
}

/** Server-resolved scope and committed upload; these are never client claims. */
export type AutocontrolCaptureContext = {
  ofId: number;
  operationId: string;
  controlId: string;
  mode: AutocontrolCaptureMode;
  scan: null | {
    controlId: string;
    ofId: number;
    operationId: string;
    removed: boolean;
    uploadCommitted: boolean;
    antivirusClean: boolean;
    mimeType: string;
    bytes: number;
  };
};

/** A paper scan satisfies capture only. It never pronounces a quality verdict. */
export function assertAutocontrolCapture(context: AutocontrolCaptureContext) {
  if (context.mode === "DIGITAL") {
    return { measurementsRequired: true, scanRequired: false, qualityDecisionRequired: true } as const;
  }
  const scan = context.scan;
  if (!scan) throw new HttpError(422, "AUTOCONTROL_SCAN_REQUIRED", "Joignez la fiche papier renseignée.");
  if (scan.controlId !== context.controlId || scan.ofId !== context.ofId || scan.operationId !== context.operationId) {
    throw new HttpError(409, "AUTOCONTROL_SCAN_SCOPE_MISMATCH", "La fiche doit appartenir à cet OF et à cette opération.");
  }
  if (scan.removed || !scan.uploadCommitted || !scan.antivirusClean || !Number.isSafeInteger(scan.bytes) || scan.bytes <= 0) {
    throw new HttpError(409, "AUTOCONTROL_SCAN_UNAVAILABLE", "Le scan doit être enregistré et vérifié avant validation.");
  }
  if (!["application/pdf", "image/jpeg", "image/png"].includes(scan.mimeType)) {
    throw new HttpError(422, "AUTOCONTROL_SCAN_FORMAT", "Joignez un scan PDF, JPG ou PNG.");
  }
  return { measurementsRequired: false, scanRequired: true, qualityDecisionRequired: true } as const;
}
