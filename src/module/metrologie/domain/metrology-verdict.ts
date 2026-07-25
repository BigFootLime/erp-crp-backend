// Calcul du verdict d'une exécution métrologique (#229) — pur, sans I/O.
//
// Le verdict CALCULÉ est la vérité du relevé. Le verdict RETENU peut en
// différer, mais uniquement par décision humaine justifiée et tracée
// (`assertManualVerdictOverride` dans `metrology-policy`).

import { convertValue, sameDimension } from "./metrology-units";
import type { MetrologyOperationType, MetrologyVerdict } from "./metrology-policy";

export type MeasurementInput = {
  point_key: string;
  sample_no: number;
  nominal: number | null;
  tolerance_min: number | null;
  tolerance_max: number | null;
  measured: number | null;
  unite: string | null;
  incertitude: number | null;
};

export type PlanCriteria = {
  tolerance_min: number | null;
  tolerance_max: number | null;
  unite: string | null;
  /**
   * Nombre minimum de points attendus par la procédure. Une exécution qui n'en
   * couvre pas assez n'est pas conforme : elle est INCONCLUE.
   */
  min_points: number | null;
};

export type MeasurementVerdict = {
  point_key: string;
  sample_no: number;
  verdict: "CONFORME" | "NON_CONFORME" | "INCONCLU";
  ecart: number | null;
  reason: string | null;
};

export type VerdictComputation = {
  verdict: MetrologyVerdict;
  points: MeasurementVerdict[];
  counts: {
    total: number;
    conforme: number;
    non_conforme: number;
    inconclu: number;
  };
  /** Explication affichable telle quelle par l'assistant de saisie. */
  explanation: string;
};

/**
 * Verdict d'un point de mesure.
 *
 * Les bornes du point priment sur celles du plan : un plan donne le critère par
 * défaut, la procédure peut le préciser point par point.
 */
export function evaluateMeasurement(
  measurement: MeasurementInput,
  criteria: PlanCriteria
): MeasurementVerdict {
  const base: Pick<MeasurementVerdict, "point_key" | "sample_no"> = {
    point_key: measurement.point_key,
    sample_no: measurement.sample_no,
  };

  if (measurement.measured === null || !Number.isFinite(measurement.measured)) {
    return { ...base, verdict: "INCONCLU", ecart: null, reason: "Aucune valeur relevée." };
  }

  const bounds = resolveBounds(measurement, criteria);
  if (bounds === "UNIT_MISMATCH") {
    return {
      ...base,
      verdict: "INCONCLU",
      ecart: null,
      reason: "Unités incompatibles entre le relevé et le critère du plan.",
    };
  }

  const ecart =
    measurement.nominal !== null && Number.isFinite(measurement.nominal)
      ? round(measurement.measured - measurement.nominal)
      : null;

  if (bounds.min === null && bounds.max === null) {
    return {
      ...base,
      verdict: "INCONCLU",
      ecart,
      reason: "Aucun critère d'acceptation : le point ne peut pas être jugé.",
    };
  }

  if (bounds.min !== null && measurement.measured < bounds.min) {
    return {
      ...base,
      verdict: "NON_CONFORME",
      ecart,
      reason: `Valeur ${measurement.measured} sous la borne basse ${bounds.min}.`,
    };
  }
  if (bounds.max !== null && measurement.measured > bounds.max) {
    return {
      ...base,
      verdict: "NON_CONFORME",
      ecart,
      reason: `Valeur ${measurement.measured} au-dessus de la borne haute ${bounds.max}.`,
    };
  }

  return { ...base, verdict: "CONFORME", ecart, reason: null };
}

function resolveBounds(
  measurement: MeasurementInput,
  criteria: PlanCriteria
): { min: number | null; max: number | null } | "UNIT_MISMATCH" {
  if (measurement.tolerance_min !== null || measurement.tolerance_max !== null) {
    return { min: measurement.tolerance_min, max: measurement.tolerance_max };
  }
  if (criteria.tolerance_min === null && criteria.tolerance_max === null) {
    return { min: null, max: null };
  }

  const from = criteria.unite;
  const to = measurement.unite;
  if (!from || !to || from.trim().toLowerCase() === to.trim().toLowerCase()) {
    return { min: criteria.tolerance_min, max: criteria.tolerance_max };
  }
  if (!sameDimension(from, to)) return "UNIT_MISMATCH";

  const min = criteria.tolerance_min === null ? null : convertValue(criteria.tolerance_min, from, to);
  const max = criteria.tolerance_max === null ? null : convertValue(criteria.tolerance_max, from, to);
  if ((min && !min.ok) || (max && !max.ok)) return "UNIT_MISMATCH";

  return {
    min: min && min.ok ? round(min.value) : null,
    max: max && max.ok ? round(max.value) : null,
  };
}

/**
 * Verdict global.
 *
 * Ordre de priorité — un seul point hors tolérance suffit à rendre l'exécution
 * non conforme : on ne « moyenne » jamais des relevés métrologiques.
 */
export function computeExecutionVerdict(params: {
  operationType: MetrologyOperationType;
  measurements: readonly MeasurementInput[];
  criteria: PlanCriteria;
}): VerdictComputation {
  const points = params.measurements.map((measurement) =>
    evaluateMeasurement(measurement, params.criteria)
  );

  const counts = {
    total: points.length,
    conforme: points.filter((point) => point.verdict === "CONFORME").length,
    non_conforme: points.filter((point) => point.verdict === "NON_CONFORME").length,
    inconclu: points.filter((point) => point.verdict === "INCONCLU").length,
  };

  // Un ajustage ou une réparation n'est pas un jugement d'aptitude : sans
  // relevé, il reste inconclusif et n'ouvre aucun droit d'emploi.
  if (points.length === 0) {
    return {
      verdict: "INCONCLU",
      points,
      counts,
      explanation:
        params.operationType === "AJUSTAGE" || params.operationType === "REPARATION"
          ? "Intervention technique sans relevé : une requalification est nécessaire avant remise en service."
          : "Aucun relevé saisi : l'exécution ne peut pas conclure.",
    };
  }

  const minPoints = params.criteria.min_points;
  if (minPoints !== null && points.length < minPoints) {
    return {
      verdict: "INCONCLU",
      points,
      counts,
      explanation: `Procédure incomplète : ${points.length} point(s) relevé(s) pour ${minPoints} attendu(s).`,
    };
  }

  if (counts.non_conforme > 0) {
    return {
      verdict: "NON_CONFORME",
      points,
      counts,
      explanation: `${counts.non_conforme} point(s) hors tolérance sur ${counts.total}.`,
    };
  }

  if (counts.inconclu > 0) {
    return {
      verdict: "INCONCLU",
      points,
      counts,
      explanation: `${counts.inconclu} point(s) non jugeable(s) sur ${counts.total} : complétez le relevé ou le critère.`,
    };
  }

  return {
    verdict: "CONFORME",
    points,
    counts,
    explanation: `${counts.conforme} point(s) dans la tolérance sur ${counts.total}.`,
  };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
