import { HttpError } from "../../../utils/httpError";
import type { AutocontrolCaptureMode } from "./autocontrol-capture";
import { resolveCharacteristicBounds, type QualityCharacteristicSpec, type VerdictComputation } from "./quality-plan";

export const AUTOCONTROL_CONFIRMED = "AUTOCONTROL_CONFIRMED";
export const SUBCONTRACT_AUTOCONTROL_ISSUED = "SUBCONTRACT_AUTOCONTROL_ISSUED";

export type AutocontrolDimension = {
  characteristicKey: string;
  sampleNo: number;
  label: string;
  valueMm: number;
  minMm?: number;
  maxMm?: number;
};

export type AutocontrolProof = {
  controlId: string;
  operationId: string;
  ofId: number;
  lotId: string | null;
  mode: AutocontrolCaptureMode;
  confirmedAt: string;
  contentSha256: string;
  snapshotSha256: string;
  conformingQuantity: number;
  unit: string;
  documentId?: string;
  documentSha256?: string;
  measurements: AutocontrolDimension[];
};

export function assertCompleteDigitalAutocontrol(
  specs: readonly QualityCharacteristicSpec[],
  computation: VerdictComputation,
) {
  const requiredKeys = new Set(specs.filter(spec => spec.mandatory).map(spec => spec.key));
  if (computation.verdict === "EN_ATTENTE" ||
    computation.missing.some(item => requiredKeys.has(item.characteristic_key))) {
    throw new HttpError(422, "AUTOCONTROL_MEASUREMENTS_INCOMPLETE", "Renseignez toutes les mesures obligatoires avant de valider l’autocontrôle.");
  }
}

export function confirmedDimensions(
  specs: readonly QualityCharacteristicSpec[],
  measurements: ReadonlyArray<{ characteristic_key: string | null; sample_no: number | null; measured_value: number | null }>,
): AutocontrolDimension[] {
  const byKey = new Map(specs.map(spec => [spec.key, spec]));
  return measurements.flatMap(measurement => {
    const spec = measurement.characteristic_key && byKey.get(measurement.characteristic_key);
    if (!spec || spec.value_kind !== "NUMERIC" || spec.unit?.trim().toLowerCase() !== "mm" ||
      measurement.measured_value === null || measurement.sample_no === null) return [];
    const { min, max } = resolveCharacteristicBounds(spec);
    return [{
      characteristicKey: spec.key, sampleNo: measurement.sample_no, label: spec.label, valueMm: measurement.measured_value,
      ...(min === null ? {} : { minMm: min }), ...(max === null ? {} : { maxMm: max }),
    }];
  });
}
