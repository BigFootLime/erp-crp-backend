// Plans de contrôle versionnés, applicabilité, échantillonnage, verdict et
// snapshot canonique (#228). Pur : aucune I/O, aucune dépendance SQL.

import { HttpError } from "../../../utils/httpError";
import { qualitySha256, type QualityVerdict } from "./quality-policy";

/* -------------------------------------------------------------------------- */
/* 1) Référentiels gouvernés                                                  */
/* -------------------------------------------------------------------------- */

export const QUALITY_CHARACTERISTIC_TYPES = [
  "DIMENSIONAL",
  "VISUAL",
  "DOCUMENTARY",
  "MATERIAL",
  "FUNCTIONAL",
  "OTHER",
] as const;
export type QualityCharacteristicType = (typeof QUALITY_CHARACTERISTIC_TYPES)[number];

export const QUALITY_VALUE_KINDS = ["NUMERIC", "BOOLEAN", "ENUM", "TEXT"] as const;
export type QualityValueKind = (typeof QUALITY_VALUE_KINDS)[number];

export const QUALITY_CRITICALITIES = ["CRITICAL", "MAJOR", "MINOR"] as const;
export type QualityCriticality = (typeof QUALITY_CRITICALITIES)[number];

export const QUALITY_TRIGGERS = [
  "RECEPTION",
  "FIRST_ARTICLE",
  "IN_PROCESS",
  "FINAL",
  "LOT_RELEASE",
  "PERIODIC",
  "RECHECK",
] as const;
export type QualityTrigger = (typeof QUALITY_TRIGGERS)[number];

// Quel déclencheur crée une exigence, lequel demande une exécution, lequel est
// informatif : la règle est explicite et testée, pas implicite.
export const TRIGGER_SEMANTICS: Readonly<
  Record<QualityTrigger, "REQUIRES_EXECUTION" | "CREATES_REQUIREMENT" | "INFORMATIVE">
> = {
  RECEPTION: "REQUIRES_EXECUTION",
  FIRST_ARTICLE: "REQUIRES_EXECUTION",
  IN_PROCESS: "CREATES_REQUIREMENT",
  FINAL: "REQUIRES_EXECUTION",
  LOT_RELEASE: "REQUIRES_EXECUTION",
  PERIODIC: "CREATES_REQUIREMENT",
  RECHECK: "REQUIRES_EXECUTION",
};

export const QUALITY_SAMPLING_RULES = ["ALL", "FIXED", "PERCENT", "FIRST_ARTICLE", "LOT"] as const;
export type QualitySamplingRule = (typeof QUALITY_SAMPLING_RULES)[number];

export type QualitySampling = {
  rule: QualitySamplingRule;
  // FIXED → nombre d'unités ; PERCENT → pourcentage 0 < p ≤ 100 ; sinon null.
  value: number | null;
  justification: string | null;
};

/* -------------------------------------------------------------------------- */
/* 2) Caractéristique de plan                                                 */
/* -------------------------------------------------------------------------- */

export type QualityCharacteristicSpec = {
  key: string;
  position: number;
  label: string;
  characteristic_type: QualityCharacteristicType;
  value_kind: QualityValueKind;
  unit: string | null;
  // Sémantique conservée du module historique : quand `nominal` est présent,
  // tolerance_min/max sont des ÉCARTS ; sinon ce sont des bornes absolues.
  nominal: number | null;
  tolerance_min: number | null;
  tolerance_max: number | null;
  precision: number | null;
  expected_boolean: boolean | null;
  allowed_values: readonly string[] | null;
  criticality: QualityCriticality;
  mandatory: boolean;
  requires_instrument: boolean;
  instrument_category: string | null;
  method: string | null;
  acceptance_rule: string | null;
  sampling: QualitySampling;
  trigger: QualityTrigger;
};

export function resolveCharacteristicBounds(spec: {
  nominal: number | null;
  tolerance_min: number | null;
  tolerance_max: number | null;
}): { min: number | null; max: number | null } {
  const hasNominal = spec.nominal !== null && Number.isFinite(spec.nominal);
  const hasTolerance = spec.tolerance_min !== null || spec.tolerance_max !== null;
  if (hasNominal && hasTolerance) {
    return {
      min: spec.tolerance_min === null ? null : Number(spec.nominal) + Number(spec.tolerance_min),
      max: spec.tolerance_max === null ? null : Number(spec.nominal) + Number(spec.tolerance_max),
    };
  }
  return {
    min: spec.tolerance_min === null ? null : Number(spec.tolerance_min),
    max: spec.tolerance_max === null ? null : Number(spec.tolerance_max),
  };
}

export function assertCharacteristicSpec(spec: QualityCharacteristicSpec): void {
  const fail = (code: string, message: string, details?: unknown): never => {
    throw new HttpError(422, code, message, details ?? { characteristic: spec.key });
  };

  if (!spec.key.trim()) fail("QUALITY_CHARACTERISTIC_KEY_REQUIRED", "Identifiant de caractéristique requis.");
  if (!Number.isInteger(spec.position) || spec.position < 1) {
    fail("QUALITY_CHARACTERISTIC_POSITION_INVALID", "La position doit être un entier ≥ 1.");
  }
  if (!spec.label.trim()) fail("QUALITY_CHARACTERISTIC_LABEL_REQUIRED", "Désignation requise.");

  for (const numeric of [spec.nominal, spec.tolerance_min, spec.tolerance_max, spec.precision]) {
    if (numeric !== null && !Number.isFinite(numeric)) {
      fail("QUALITY_CHARACTERISTIC_NUMBER_INVALID", "Valeur numérique non finie interdite.");
    }
  }

  if (spec.value_kind === "NUMERIC") {
    const bounds = resolveCharacteristicBounds(spec);
    if (bounds.min === null && bounds.max === null) {
      fail(
        "QUALITY_CHARACTERISTIC_TOLERANCE_REQUIRED",
        "Une caractéristique numérique exige au moins une borne de tolérance."
      );
    }
    if (bounds.min !== null && bounds.max !== null && bounds.min > bounds.max) {
      fail("QUALITY_CHARACTERISTIC_TOLERANCE_RANGE", "Tolérance incohérente : min > max.");
    }
    if (!spec.unit || !spec.unit.trim()) {
      fail("QUALITY_CHARACTERISTIC_UNIT_REQUIRED", "Une caractéristique numérique exige une unité.");
    }
  }

  if (spec.value_kind === "BOOLEAN" && spec.expected_boolean === null) {
    fail("QUALITY_CHARACTERISTIC_EXPECTED_REQUIRED", "Attendu booléen manquant.");
  }

  if (spec.value_kind === "ENUM") {
    const values = (spec.allowed_values ?? []).map((v) => v.trim()).filter(Boolean);
    if (values.length < 1) {
      fail("QUALITY_CHARACTERISTIC_ENUM_REQUIRED", "Une caractéristique liste exige des valeurs autorisées.");
    }
    if (new Set(values).size !== values.length) {
      fail("QUALITY_CHARACTERISTIC_ENUM_DUPLICATE", "Valeurs autorisées dupliquées.");
    }
  }

  if (spec.requires_instrument && spec.value_kind === "TEXT") {
    fail(
      "QUALITY_CHARACTERISTIC_INSTRUMENT_UNSUPPORTED",
      "Un moyen de contrôle ne s'associe pas à une caractéristique purement textuelle."
    );
  }

  assertSampling(spec.sampling, spec.key);
}

export function assertSampling(sampling: QualitySampling, characteristicKey: string): void {
  const fail = (code: string, message: string): never => {
    throw new HttpError(422, code, message, { characteristic: characteristicKey });
  };
  if (sampling.rule === "FIXED") {
    if (!Number.isInteger(sampling.value) || (sampling.value ?? 0) < 1) {
      fail("QUALITY_SAMPLING_FIXED_INVALID", "Un échantillonnage FIXED exige un entier ≥ 1.");
    }
  } else if (sampling.rule === "PERCENT") {
    const value = sampling.value ?? Number.NaN;
    if (!Number.isFinite(value) || value <= 0 || value > 100) {
      fail("QUALITY_SAMPLING_PERCENT_INVALID", "Un échantillonnage PERCENT exige 0 < p ≤ 100.");
    }
  } else if (sampling.value !== null) {
    fail("QUALITY_SAMPLING_VALUE_UNEXPECTED", "Cette règle d'échantillonnage n'accepte pas de valeur.");
  }
}

/**
 * Taille d'échantillon exigée. Aucune norme d'échantillonnage statistique
 * (ISO 2859, AQL…) n'est revendiquée ici : seules les règles explicitement
 * validées avec la Qualité sont implémentées.
 */
export function requiredSampleCount(spec: QualityCharacteristicSpec, population: number): number {
  if (!Number.isFinite(population) || population <= 0) return 0;
  const pop = Math.floor(population);
  switch (spec.sampling.rule) {
    case "ALL":
      return pop;
    case "LOT":
      return 1;
    case "FIRST_ARTICLE":
      return 1;
    case "FIXED":
      return Math.min(pop, Math.max(1, Math.floor(spec.sampling.value ?? 1)));
    case "PERCENT":
      return Math.min(pop, Math.max(1, Math.ceil((pop * (spec.sampling.value ?? 0)) / 100)));
  }
}

// Une caractéristique documentaire ou évaluée au niveau du lot ne peut pas être
// « partiellement » conforme : son échec disqualifie l'ensemble.
export function isLotLevelCharacteristic(spec: QualityCharacteristicSpec): boolean {
  return spec.sampling.rule === "LOT" || spec.characteristic_type === "DOCUMENTARY";
}

/* -------------------------------------------------------------------------- */
/* 3) Évaluation d'une mesure                                                 */
/* -------------------------------------------------------------------------- */

export type QualitySampleValue = {
  characteristic_key: string;
  sample_no: number;
  value_numeric: number | null;
  value_boolean: boolean | null;
  value_text: string | null;
  unit: string | null;
  evidence_count: number;
};

export type CharacteristicEvaluation = {
  characteristic_key: string;
  sample_no: number;
  result: "OK" | "NOK" | "PENDING";
  code:
    | "OK"
    | "PENDING_VALUE"
    | "OUT_OF_TOLERANCE"
    | "UNIT_MISMATCH"
    | "VALUE_NOT_FINITE"
    | "BOOLEAN_MISMATCH"
    | "ENUM_NOT_ALLOWED"
    | "TEXT_REQUIRED"
    | "EVIDENCE_REQUIRED";
};

export function evaluateSample(
  spec: QualityCharacteristicSpec,
  sample: QualitySampleValue
): CharacteristicEvaluation {
  const base = { characteristic_key: spec.key, sample_no: sample.sample_no };

  if (spec.value_kind === "NUMERIC") {
    if (sample.value_numeric === null || sample.value_numeric === undefined) {
      return { ...base, result: "PENDING", code: "PENDING_VALUE" };
    }
    if (!Number.isFinite(sample.value_numeric)) {
      return { ...base, result: "NOK", code: "VALUE_NOT_FINITE" };
    }
    if (spec.unit && sample.unit && spec.unit.trim() !== sample.unit.trim()) {
      return { ...base, result: "NOK", code: "UNIT_MISMATCH" };
    }
    const bounds = resolveCharacteristicBounds(spec);
    if (bounds.min !== null && sample.value_numeric < bounds.min) {
      return { ...base, result: "NOK", code: "OUT_OF_TOLERANCE" };
    }
    if (bounds.max !== null && sample.value_numeric > bounds.max) {
      return { ...base, result: "NOK", code: "OUT_OF_TOLERANCE" };
    }
    return { ...base, result: "OK", code: "OK" };
  }

  if (spec.value_kind === "BOOLEAN") {
    if (sample.value_boolean === null || sample.value_boolean === undefined) {
      return { ...base, result: "PENDING", code: "PENDING_VALUE" };
    }
    if (spec.expected_boolean !== null && sample.value_boolean !== spec.expected_boolean) {
      return { ...base, result: "NOK", code: "BOOLEAN_MISMATCH" };
    }
    return { ...base, result: "OK", code: "OK" };
  }

  if (spec.value_kind === "ENUM") {
    const raw = (sample.value_text ?? "").trim();
    if (!raw) return { ...base, result: "PENDING", code: "PENDING_VALUE" };
    const allowed = (spec.allowed_values ?? []).map((v) => v.trim());
    if (!allowed.includes(raw)) {
      return { ...base, result: "NOK", code: "ENUM_NOT_ALLOWED" };
    }
    return { ...base, result: "OK", code: "OK" };
  }

  // TEXT : documentaire ou observation. La preuve jointe est exigée quand la
  // caractéristique est critique.
  const text = (sample.value_text ?? "").trim();
  if (!text) return { ...base, result: "PENDING", code: "PENDING_VALUE" };
  if (spec.criticality === "CRITICAL" && sample.evidence_count <= 0) {
    return { ...base, result: "NOK", code: "EVIDENCE_REQUIRED" };
  }
  return { ...base, result: "OK", code: "OK" };
}

/* -------------------------------------------------------------------------- */
/* 4) Verdict d'exécution                                                     */
/* -------------------------------------------------------------------------- */

export type VerdictComputation = {
  verdict: QualityVerdict;
  evaluations: CharacteristicEvaluation[];
  missing: Array<{ characteristic_key: string; expected_samples: number; recorded_samples: number }>;
  blocking: Array<{ characteristic_key: string; criticality: QualityCriticality; code: string }>;
  ok_count: number;
  nok_count: number;
};

export function computeExecutionVerdict(params: {
  characteristics: readonly QualityCharacteristicSpec[];
  samples: readonly QualitySampleValue[];
  population: number;
}): VerdictComputation {
  const evaluations: CharacteristicEvaluation[] = [];
  const missing: VerdictComputation["missing"] = [];
  const blocking: VerdictComputation["blocking"] = [];

  let okCount = 0;
  let nokCount = 0;
  let lotLevelFailure = false;
  let mandatoryIncomplete = false;

  for (const spec of params.characteristics) {
    const expected = requiredSampleCount(spec, params.population);
    const specSamples = params.samples.filter((s) => s.characteristic_key === spec.key);

    const seen = new Set<number>();
    for (const sample of specSamples) {
      if (seen.has(sample.sample_no)) {
        throw new HttpError(
          422,
          "QUALITY_SAMPLE_DUPLICATE",
          `Échantillon dupliqué pour ${spec.key} (n° ${sample.sample_no}).`
        );
      }
      seen.add(sample.sample_no);
    }

    const evaluated = specSamples.map((sample) => evaluateSample(spec, sample));
    evaluations.push(...evaluated);

    const decided = evaluated.filter((e) => e.result !== "PENDING");
    if (decided.length < expected) {
      missing.push({
        characteristic_key: spec.key,
        expected_samples: expected,
        recorded_samples: decided.length,
      });
      if (spec.mandatory) mandatoryIncomplete = true;
    }

    for (const evaluation of evaluated) {
      if (evaluation.result === "OK") okCount += 1;
      if (evaluation.result === "NOK") {
        nokCount += 1;
        blocking.push({
          characteristic_key: spec.key,
          criticality: spec.criticality,
          code: evaluation.code,
        });
        if (isLotLevelCharacteristic(spec)) lotLevelFailure = true;
      }
    }
  }

  let verdict: QualityVerdict;
  if (mandatoryIncomplete) {
    verdict = "EN_ATTENTE";
  } else if (lotLevelFailure) {
    verdict = "NON_CONFORME";
  } else if (nokCount === 0 && okCount === 0) {
    verdict = "EN_ATTENTE";
  } else if (nokCount === 0) {
    verdict = "CONFORME";
  } else if (okCount === 0) {
    verdict = "NON_CONFORME";
  } else {
    verdict = "PARTIEL";
  }

  return { verdict, evaluations, missing, blocking, ok_count: okCount, nok_count: nokCount };
}

/* -------------------------------------------------------------------------- */
/* 5) Applicabilité d'un plan                                                 */
/* -------------------------------------------------------------------------- */

export type PlanApplicabilityScope = {
  article_id: string | null;
  piece_technique_id: string | null;
  piece_version_id: string | null;
  famille_id: string | null;
  operation_code: string | null;
  fournisseur_id: string | null;
  trigger: QualityTrigger;
  effective_from: string | null;
  effective_to: string | null;
};

export type PlanCandidate = {
  id: string;
  code: string;
  version: number;
  status: "DRAFT" | "IN_REVIEW" | "PUBLISHED" | "ARCHIVED";
  scope: PlanApplicabilityScope;
};

export type ApplicabilityContext = {
  article_id: string | null;
  piece_technique_id: string | null;
  piece_version_id: string | null;
  famille_id: string | null;
  operation_code: string | null;
  fournisseur_id: string | null;
  trigger: QualityTrigger;
};

// Règle de priorité documentée : le périmètre le plus spécifique gagne.
// version de pièce (8) > pièce technique (4) > article (2) > famille (1),
// plus un bonus opération (16) et fournisseur (32) qui ne remplacent jamais
// l'axe produit mais le précisent.
const SPECIFICITY_WEIGHTS = {
  piece_version_id: 8,
  piece_technique_id: 4,
  article_id: 2,
  famille_id: 1,
  operation_code: 16,
  fournisseur_id: 32,
} as const;

export function planScopeSpecificity(scope: PlanApplicabilityScope): number {
  let score = 0;
  for (const [field, weight] of Object.entries(SPECIFICITY_WEIGHTS)) {
    if (scope[field as keyof typeof SPECIFICITY_WEIGHTS]) score += weight;
  }
  return score;
}

function scopeMatchesContext(scope: PlanApplicabilityScope, context: ApplicabilityContext): boolean {
  if (scope.trigger !== context.trigger) return false;
  const axes: Array<keyof typeof SPECIFICITY_WEIGHTS> = [
    "piece_version_id",
    "piece_technique_id",
    "article_id",
    "famille_id",
    "operation_code",
    "fournisseur_id",
  ];
  for (const axis of axes) {
    const expected = scope[axis];
    if (!expected) continue; // périmètre ouvert sur cet axe
    if (context[axis] !== expected) return false;
  }
  // Un plan sans aucun axe produit ne s'applique pas implicitement à tout.
  return Boolean(
    scope.piece_version_id || scope.piece_technique_id || scope.article_id || scope.famille_id
  );
}

function isEffectiveAt(scope: PlanApplicabilityScope, at: Date): boolean {
  if (scope.effective_from) {
    const from = new Date(scope.effective_from);
    if (!Number.isNaN(from.getTime()) && at < from) return false;
  }
  if (scope.effective_to) {
    const to = new Date(scope.effective_to);
    if (!Number.isNaN(to.getTime()) && at > to) return false;
  }
  return true;
}

export type PlanSelection = {
  plan: PlanCandidate;
  specificity: number;
  discarded: Array<{ id: string; reason: "SCOPE" | "STATUS" | "PERIOD" | "LESS_SPECIFIC" }>;
};

/**
 * Sélectionne le plan applicable côté serveur. Deux plans publiés de même
 * spécificité sur le même périmètre au même instant = ambiguïté refusée (409),
 * jamais un choix arbitraire.
 */
export function selectApplicablePlan(
  candidates: readonly PlanCandidate[],
  context: ApplicabilityContext,
  at: Date
): PlanSelection {
  const discarded: PlanSelection["discarded"] = [];
  const eligible: Array<{ plan: PlanCandidate; specificity: number }> = [];

  for (const candidate of candidates) {
    if (candidate.status !== "PUBLISHED") {
      discarded.push({ id: candidate.id, reason: "STATUS" });
      continue;
    }
    if (!scopeMatchesContext(candidate.scope, context)) {
      discarded.push({ id: candidate.id, reason: "SCOPE" });
      continue;
    }
    if (!isEffectiveAt(candidate.scope, at)) {
      discarded.push({ id: candidate.id, reason: "PERIOD" });
      continue;
    }
    eligible.push({ plan: candidate, specificity: planScopeSpecificity(candidate.scope) });
  }

  if (eligible.length === 0) {
    throw new HttpError(
      422,
      "QUALITY_PLAN_NOT_APPLICABLE",
      "Aucun plan de contrôle publié n'est applicable à ce contexte.",
      { discarded }
    );
  }

  const best = Math.max(...eligible.map((e) => e.specificity));
  const top = eligible.filter((e) => e.specificity === best);
  for (const entry of eligible) {
    if (entry.specificity !== best) discarded.push({ id: entry.plan.id, reason: "LESS_SPECIFIC" });
  }

  if (top.length > 1) {
    throw new HttpError(
      409,
      "QUALITY_PLAN_AMBIGUOUS",
      "Plusieurs plans de contrôle publiés sont applicables avec la même spécificité.",
      { candidates: top.map((e) => ({ id: e.plan.id, code: e.plan.code, version: e.plan.version })) }
    );
  }

  return { plan: top[0]!.plan, specificity: best, discarded };
}

/**
 * Empêche de publier une version qui rendrait deux plans ambigus sur la même
 * fenêtre d'effet : appelée avant `PUBLISHED`.
 */
export function assertNoApplicabilityOverlap(params: {
  candidate: PlanCandidate;
  published: readonly PlanCandidate[];
}): void {
  const candidateSpecificity = planScopeSpecificity(params.candidate.scope);
  const conflicts = params.published.filter((other) => {
    if (other.id === params.candidate.id) return false;
    if (other.status !== "PUBLISHED") return false;
    if (other.scope.trigger !== params.candidate.scope.trigger) return false;
    if (planScopeSpecificity(other.scope) !== candidateSpecificity) return false;
    const axes: Array<keyof typeof SPECIFICITY_WEIGHTS> = [
      "piece_version_id",
      "piece_technique_id",
      "article_id",
      "famille_id",
      "operation_code",
      "fournisseur_id",
    ];
    const sameScope = axes.every((axis) => (other.scope[axis] ?? null) === (params.candidate.scope[axis] ?? null));
    if (!sameScope) return false;
    return periodsOverlap(other.scope, params.candidate.scope);
  });

  if (conflicts.length > 0) {
    throw new HttpError(
      409,
      "QUALITY_PLAN_APPLICABILITY_OVERLAP",
      "Publication refusée : un plan publié couvre déjà ce périmètre sur la même période.",
      { conflicts: conflicts.map((c) => ({ id: c.id, code: c.code, version: c.version })) }
    );
  }
}

function periodsOverlap(left: PlanApplicabilityScope, right: PlanApplicabilityScope): boolean {
  const leftFrom = left.effective_from ? new Date(left.effective_from).getTime() : Number.NEGATIVE_INFINITY;
  const leftTo = left.effective_to ? new Date(left.effective_to).getTime() : Number.POSITIVE_INFINITY;
  const rightFrom = right.effective_from ? new Date(right.effective_from).getTime() : Number.NEGATIVE_INFINITY;
  const rightTo = right.effective_to ? new Date(right.effective_to).getTime() : Number.POSITIVE_INFINITY;
  return leftFrom <= rightTo && rightFrom <= leftTo;
}

/* -------------------------------------------------------------------------- */
/* 6) Snapshot canonique + intégrité                                          */
/* -------------------------------------------------------------------------- */

export type PlanSnapshotSources = {
  plan: {
    id: string;
    code: string;
    version: number;
    label: string;
    trigger: QualityTrigger;
    scope: PlanApplicabilityScope;
    published_at: string | null;
  };
  characteristics: readonly QualityCharacteristicSpec[];
  article: { id: string | null; code: string | null; designation: string | null };
  piece: { id: string | null; code: string | null; designation: string | null; version: string | null };
  population: number;
  sampling_algorithm: string;
  required_documents: readonly { id: string; label: string; revision: string | null }[];
};

export type PlanSnapshot = {
  payload: Record<string, unknown>;
  sha256: string;
};

/**
 * Fige le contenu réellement appliqué à l'exécution. On stocke le payload
 * canonique ET son empreinte : le verdict historique ne doit jamais être
 * recalculé depuis le plan courant.
 */
export function buildPlanSnapshot(sources: PlanSnapshotSources): PlanSnapshot {
  const payload: Record<string, unknown> = {
    schema: "cerp.quality.plan-snapshot.v1",
    plan: {
      id: sources.plan.id,
      code: sources.plan.code,
      version: sources.plan.version,
      label: sources.plan.label,
      trigger: sources.plan.trigger,
      published_at: sources.plan.published_at,
      scope: sources.plan.scope,
    },
    article: sources.article,
    piece: sources.piece,
    population: sources.population,
    sampling_algorithm: sources.sampling_algorithm,
    required_documents: sources.required_documents.map((doc) => ({
      id: doc.id,
      label: doc.label,
      revision: doc.revision,
    })),
    characteristics: [...sources.characteristics]
      .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))
      .map((spec) => ({
        key: spec.key,
        position: spec.position,
        label: spec.label,
        characteristic_type: spec.characteristic_type,
        value_kind: spec.value_kind,
        unit: spec.unit,
        nominal: spec.nominal,
        tolerance_min: spec.tolerance_min,
        tolerance_max: spec.tolerance_max,
        precision: spec.precision,
        expected_boolean: spec.expected_boolean,
        allowed_values: spec.allowed_values ? [...spec.allowed_values] : null,
        criticality: spec.criticality,
        mandatory: spec.mandatory,
        requires_instrument: spec.requires_instrument,
        instrument_category: spec.instrument_category,
        method: spec.method,
        acceptance_rule: spec.acceptance_rule,
        sampling: spec.sampling,
        trigger: spec.trigger,
        required_samples: requiredSampleCount(spec, sources.population),
      })),
  };

  return { payload, sha256: qualitySha256(payload) };
}

export function assertSnapshotIntegrity(payload: unknown, expectedSha256: string): void {
  const actual = qualitySha256(payload);
  if (actual !== expectedSha256) {
    throw new HttpError(
      409,
      "QUALITY_SNAPSHOT_TAMPERED",
      "Alerte d'intégrité : le snapshot du plan ne correspond plus à son empreinte SHA-256.",
      { expected_sha256: expectedSha256, actual_sha256: actual }
    );
  }
}

export function characteristicsFromSnapshot(payload: unknown): QualityCharacteristicSpec[] {
  if (!payload || typeof payload !== "object") return [];
  const raw = (payload as { characteristics?: unknown }).characteristics;
  if (!Array.isArray(raw)) return [];
  return raw as QualityCharacteristicSpec[];
}
