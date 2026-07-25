// Éligibilité d'emploi d'un instrument (#229) — décision pure, sans I/O.
//
// SEUL LE SERVEUR décide qu'un instrument peut servir à une mesure. Le
// frontend affiche l'explication produite ici ; il ne rejoue jamais la règle et
// ne peut pas la contourner en masquant un message.
//
// L'évaluation produit une LISTE de raisons explicables (et pas un simple
// booléen) parce qu'un opérateur d'atelier doit comprendre pourquoi son pied à
// coulisse est refusé, sans appeler la métrologie.

import {
  convertValue,
  resolveUnit,
  sameDimension,
} from "./metrology-units";
import type { MetrologyEquipmentState } from "./metrology-policy";
import { equipmentStateBlocksUsage } from "./metrology-policy";
import { evaluateDue, type DueEvaluation } from "./metrology-schedule";

/* -------------------------------------------------------------------------- */
/* 1) Entrées                                                                 */
/* -------------------------------------------------------------------------- */

/** Photographie serveur d'un instrument, telle que chargée en base. */
export type MetrologyInstrumentState = {
  id: string;
  code: string | null;
  designation: string | null;
  categorie_code: string | null;
  sous_categorie_code: string | null;
  /** Champ texte historique, conservé pour les instruments non recatégorisés. */
  categorie_legacy: string | null;
  etat: MetrologyEquipmentState;
  criticite: "NORMAL" | "CRITIQUE" | string | null;
  deleted: boolean;

  unite: string | null;
  plage_min: number | null;
  plage_max: number | null;
  resolution: number | null;
  mpe: number | null;
  incertitude: number | null;
  methodes: readonly string[];
  restrictions: string | null;
  exige_certificat: boolean;

  /** Plan actif applicable au type d'opération qui fait foi pour l'échéance. */
  plan_version_id: string | null;
  plan_version: number | null;
  plan_blocking_strategy: "BLOCK" | "WARN" | "NONE" | null;
  plan_alert_window_days: number | null;
  next_due_date: string | null;

  /** Dernière preuve admissible et sa pièce justificative. */
  last_proof_execution_id: string | null;
  last_proof_date: string | null;
  last_proof_verdict: string | null;
  has_valid_certificate: boolean;
  certificate_id: string | null;
};

/** Ce que la caractéristique qualité exige de l'instrument. */
export type MetrologyUsageRequirement = {
  characteristic_key: string;
  requires_instrument: boolean;
  /** Catégorie attendue : code référentiel #229 ou libellé historique #228. */
  instrument_category: string | null;
  method: string | null;
  unit: string | null;
  nominal: number | null;
  tolerance_min: number | null;
  tolerance_max: number | null;
  /** Preuve documentaire exigée par le plan de contrôle. */
  requires_certificate: boolean;
};

export type MetrologyPolicySettings = {
  /**
   * Réglage historique `metrologie.block_on_overdue_critical`. Portée
   * PER_INSTRUMENT : il ne bloque QUE l'instrument critique réellement échu et
   * réellement utilisé. Il n'a jamais valeur de verrou global d'usine.
   */
  block_on_overdue_critical: boolean;
};

export type MetrologyActorRights = {
  canRecordMeasurement: boolean;
};

/* -------------------------------------------------------------------------- */
/* 2) Sorties                                                                 */
/* -------------------------------------------------------------------------- */

export const METROLOGY_ELIGIBILITY_CODES = [
  "OK",
  "INSTRUMENT_REQUIRED",
  "INSTRUMENT_UNKNOWN",
  "INSTRUMENT_DELETED",
  "INSTRUMENT_RETIRED",
  "INSTRUMENT_QUARANTINE",
  "INSTRUMENT_OUT_OF_TOLERANCE",
  "INSTRUMENT_UNDER_REPAIR",
  "INSTRUMENT_NOT_QUALIFIED",
  "INSTRUMENT_OUT_OF_SCOPE",
  "INSTRUMENT_METHOD_MISMATCH",
  "INSTRUMENT_UNIT_MISMATCH",
  "INSTRUMENT_UNIT_UNKNOWN",
  "INSTRUMENT_RANGE_MISMATCH",
  "INSTRUMENT_RESOLUTION_INSUFFICIENT",
  "INSTRUMENT_UNCERTAINTY_EXCESSIVE",
  "INSTRUMENT_CERTIFICATE_MISSING",
  "INSTRUMENT_OVERDUE_CRITICAL",
  "INSTRUMENT_OVERDUE",
  "INSTRUMENT_DUE_SOON",
  "INSTRUMENT_RESTRICTED",
  "OPERATOR_NOT_ALLOWED",
] as const;
export type MetrologyEligibilityCode = (typeof METROLOGY_ELIGIBILITY_CODES)[number];

export type EligibilitySeverity = "OK" | "WARNING" | "BLOCKING";

export type EligibilityReason = {
  code: MetrologyEligibilityCode;
  severity: EligibilitySeverity;
  message: string;
  /** Détail chiffré affichable tel quel (aucune donnée sensible). */
  details?: Record<string, unknown>;
};

export type MetrologyEligibility = {
  eligible: boolean;
  severity: EligibilitySeverity;
  code: MetrologyEligibilityCode;
  message: string;
  reasons: EligibilityReason[];
  due: DueEvaluation;
};

/* -------------------------------------------------------------------------- */
/* 3) Moteur                                                                  */
/* -------------------------------------------------------------------------- */

const STATE_BLOCKING_CODES: Partial<Record<MetrologyEquipmentState, MetrologyEligibilityCode>> = {
  QUARANTINE: "INSTRUMENT_QUARANTINE",
  OUT_OF_TOLERANCE: "INSTRUMENT_OUT_OF_TOLERANCE",
  UNDER_REPAIR: "INSTRUMENT_UNDER_REPAIR",
  RETIRED: "INSTRUMENT_RETIRED",
  DRAFT: "INSTRUMENT_NOT_QUALIFIED",
  SUSPENDED: "INSTRUMENT_NOT_QUALIFIED",
};

const STATE_MESSAGES: Partial<Record<MetrologyEquipmentState, string>> = {
  QUARANTINE: "Instrument en quarantaine : usage interdit tant qu'il n'est pas libéré.",
  OUT_OF_TOLERANCE: "Instrument hors tolérance : usage interdit tant qu'il n'est pas libéré.",
  UNDER_REPAIR: "Instrument en réparation ou ajustage : requalification requise avant emploi.",
  RETIRED: "Instrument retiré du parc.",
  DRAFT: "Instrument non qualifié : sa fiche n'est pas encore validée.",
  SUSPENDED: "Instrument suspendu : il n'est pas disponible pour la mesure.",
};

export function evaluateInstrumentEligibility(params: {
  requirement: MetrologyUsageRequirement;
  instrument: MetrologyInstrumentState | null;
  at: Date;
  policy: MetrologyPolicySettings;
  rights?: MetrologyActorRights;
}): MetrologyEligibility {
  const { requirement, instrument, at, policy } = params;
  const reasons: EligibilityReason[] = [];

  const emptyDue: DueEvaluation = {
    status: "UNKNOWN",
    next_due_date: null,
    days_remaining: null,
    days_overdue: 0,
  };

  if (!requirement.requires_instrument) {
    return ok("Aucun moyen de contrôle requis pour cette caractéristique.", emptyDue);
  }

  if (params.rights && !params.rights.canRecordMeasurement) {
    reasons.push({
      code: "OPERATOR_NOT_ALLOWED",
      severity: "BLOCKING",
      message: "Vous n'avez pas le droit d'enregistrer une mesure avec un instrument.",
    });
    return decide(reasons, emptyDue);
  }

  if (!instrument) {
    reasons.push({
      code: "INSTRUMENT_REQUIRED",
      severity: "BLOCKING",
      message: `La caractéristique ${requirement.characteristic_key} exige l'instrument réellement utilisé.`,
    });
    return decide(reasons, emptyDue);
  }

  if (instrument.deleted) {
    reasons.push({
      code: "INSTRUMENT_DELETED",
      severity: "BLOCKING",
      message: "Instrument retiré du registre de métrologie.",
    });
    return decide(reasons, emptyDue);
  }

  // 1) État de gouvernance : il prime sur tout le reste.
  const stateCode = STATE_BLOCKING_CODES[instrument.etat];
  if (stateCode && equipmentStateBlocksUsage(instrument.etat)) {
    reasons.push({
      code: stateCode,
      severity: "BLOCKING",
      message: STATE_MESSAGES[instrument.etat] ?? `Instrument indisponible (${instrument.etat}).`,
      details: { etat: instrument.etat },
    });
  }

  // 2) Périmètre : catégorie référentielle #229, ou libellé historique #228.
  if (requirement.instrument_category) {
    const expected = requirement.instrument_category.trim().toLowerCase();
    const candidates = [
      instrument.categorie_code,
      instrument.sous_categorie_code,
      instrument.categorie_legacy,
    ]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.trim().toLowerCase());
    if (!candidates.includes(expected)) {
      reasons.push({
        code: "INSTRUMENT_OUT_OF_SCOPE",
        severity: "BLOCKING",
        message: `Instrument hors périmètre : catégorie « ${requirement.instrument_category} » attendue.`,
        details: { expected: requirement.instrument_category, actual: candidates },
      });
    }
  }

  // 3) Méthode déclarée. Un instrument sans méthode déclarée reste utilisable :
  //    on n'invente pas une exigence là où le référentiel est muet.
  if (requirement.method && instrument.methodes.length > 0) {
    const expected = requirement.method.trim().toLowerCase();
    const supported = instrument.methodes.map((value) => value.trim().toLowerCase());
    if (!supported.includes(expected)) {
      reasons.push({
        code: "INSTRUMENT_METHOD_MISMATCH",
        severity: "BLOCKING",
        message: `Méthode « ${requirement.method} » non déclarée pour cet instrument.`,
        details: { expected: requirement.method, supported: instrument.methodes },
      });
    }
  }

  // 4) Unité et plage.
  evaluateRange(requirement, instrument, reasons);

  // 5) Résolution et incertitude face à l'intervalle de tolérance.
  evaluateCapability(requirement, instrument, reasons);

  // 6) Preuve documentaire exigée.
  if ((requirement.requires_certificate || instrument.exige_certificat) && !instrument.has_valid_certificate) {
    reasons.push({
      code: "INSTRUMENT_CERTIFICATE_MISSING",
      severity: "BLOCKING",
      message: "Aucun certificat ou PV valide n'est rattaché à la dernière preuve conforme.",
    });
  }

  // 7) Échéance : blocage CIBLÉ, piloté par la stratégie du plan applicable et
  //    par le réglage historique pour les instruments critiques.
  const due = evaluateDue({
    nextDueDate: instrument.next_due_date,
    alertWindowDays: instrument.plan_alert_window_days ?? 30,
    at,
  });
  evaluateSchedule(instrument, due, policy, reasons);

  // 8) Restriction documentée : jamais bloquante, toujours affichée.
  if (instrument.restrictions && instrument.restrictions.trim()) {
    reasons.push({
      code: "INSTRUMENT_RESTRICTED",
      severity: "WARNING",
      message: `Restriction d'emploi : ${instrument.restrictions.trim()}`,
    });
  }

  return decide(reasons, due);
}

function evaluateRange(
  requirement: MetrologyUsageRequirement,
  instrument: MetrologyInstrumentState,
  reasons: EligibilityReason[]
): void {
  const targets = [requirement.nominal, requirement.tolerance_min, requirement.tolerance_max].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value)
  );
  if (targets.length === 0) return;
  if (instrument.plage_min === null && instrument.plage_max === null) return;

  const requirementUnit = requirement.unit;
  const instrumentUnit = instrument.unite;

  if (!requirementUnit || !instrumentUnit) {
    // Sans unité des deux côtés on ne compare pas des nombres nus : on le dit.
    reasons.push({
      code: "INSTRUMENT_UNIT_UNKNOWN",
      severity: "WARNING",
      message: "Unité manquante : la compatibilité de plage n'a pas pu être vérifiée.",
      details: { requirement_unit: requirementUnit, instrument_unit: instrumentUnit },
    });
    return;
  }

  if (!resolveUnit(requirementUnit) || !resolveUnit(instrumentUnit)) {
    reasons.push({
      code: "INSTRUMENT_UNIT_UNKNOWN",
      severity: "WARNING",
      message: `Unité non reconnue (${requirementUnit} / ${instrumentUnit}) : plage non vérifiée.`,
      details: { requirement_unit: requirementUnit, instrument_unit: instrumentUnit },
    });
    return;
  }

  if (!sameDimension(requirementUnit, instrumentUnit)) {
    reasons.push({
      code: "INSTRUMENT_UNIT_MISMATCH",
      severity: "BLOCKING",
      message: `Unités incompatibles : la caractéristique est en ${requirementUnit}, l'instrument en ${instrumentUnit}.`,
      details: { requirement_unit: requirementUnit, instrument_unit: instrumentUnit },
    });
    return;
  }

  const converted = targets
    .map((value) => convertValue(value, requirementUnit, instrumentUnit))
    .filter((result): result is { ok: true; value: number } => result.ok)
    .map((result) => result.value);
  if (converted.length === 0) return;

  const min = instrument.plage_min;
  const max = instrument.plage_max;
  const outside = converted.filter(
    (value) => (min !== null && value < min) || (max !== null && value > max)
  );
  if (outside.length > 0) {
    reasons.push({
      code: "INSTRUMENT_RANGE_MISMATCH",
      severity: "BLOCKING",
      message: `Valeur hors plage de l'instrument (${min ?? "-∞"} – ${max ?? "+∞"} ${instrumentUnit}).`,
      details: {
        instrument_unit: instrumentUnit,
        plage_min: min,
        plage_max: max,
        out_of_range: outside,
      },
    });
  }
}

/**
 * Aptitude de l'instrument à l'intervalle de tolérance demandé.
 *
 * Règle usuelle d'atelier : la résolution doit valoir au plus 1/10 de
 * l'intervalle de tolérance, et l'incertitude élargie au plus 1/3. Le
 * dépassement est signalé, mais reste un AVERTISSEMENT — c'est un critère
 * d'aptitude, pas une interdiction réglementaire.
 */
function evaluateCapability(
  requirement: MetrologyUsageRequirement,
  instrument: MetrologyInstrumentState,
  reasons: EligibilityReason[]
): void {
  const { tolerance_min: lo, tolerance_max: hi, unit } = requirement;
  if (lo === null || hi === null || !unit || !instrument.unite) return;
  if (!sameDimension(unit, instrument.unite)) return;

  const span = Math.abs(hi - lo);
  if (!Number.isFinite(span) || span <= 0) return;

  const spanInInstrumentUnit = convertValue(span, unit, instrument.unite);
  if (!spanInInstrumentUnit.ok || spanInInstrumentUnit.value <= 0) return;
  const tolerance = spanInInstrumentUnit.value;

  if (instrument.resolution !== null && instrument.resolution > tolerance / 10) {
    reasons.push({
      code: "INSTRUMENT_RESOLUTION_INSUFFICIENT",
      severity: "WARNING",
      message: `Résolution ${instrument.resolution} ${instrument.unite} pour un IT de ${round(tolerance)} ${instrument.unite} : aptitude dégradée (règle 1/10).`,
      details: { resolution: instrument.resolution, tolerance_span: round(tolerance) },
    });
  }

  const uncertainty = instrument.incertitude ?? instrument.mpe;
  if (uncertainty !== null && uncertainty > tolerance / 3) {
    reasons.push({
      code: "INSTRUMENT_UNCERTAINTY_EXCESSIVE",
      severity: "WARNING",
      message: `Incertitude ${uncertainty} ${instrument.unite} pour un IT de ${round(tolerance)} ${instrument.unite} : aptitude dégradée (règle 1/3).`,
      details: { uncertainty, tolerance_span: round(tolerance) },
    });
  }
}

function evaluateSchedule(
  instrument: MetrologyInstrumentState,
  due: DueEvaluation,
  policy: MetrologyPolicySettings,
  reasons: EligibilityReason[]
): void {
  if (due.status === "DUE_SOON") {
    reasons.push({
      code: "INSTRUMENT_DUE_SOON",
      severity: "WARNING",
      message: `Échéance proche (${due.next_due_date}, dans ${due.days_remaining} j).`,
      details: { next_due_date: due.next_due_date, days_remaining: due.days_remaining },
    });
    return;
  }
  if (due.status !== "OVERDUE") return;

  const critical = String(instrument.criticite ?? "").toUpperCase() === "CRITIQUE";
  const strategy = instrument.plan_blocking_strategy ?? "WARN";

  // Le blocage est ciblé : il vient de la stratégie du plan applicable, ou du
  // réglage historique restreint aux instruments critiques échus.
  const blocking = strategy === "BLOCK" || (critical && policy.block_on_overdue_critical);
  if (strategy === "NONE" && !(critical && policy.block_on_overdue_critical)) {
    reasons.push({
      code: "INSTRUMENT_OVERDUE",
      severity: "WARNING",
      message: `Étalonnage dépassé depuis ${due.days_overdue} j (échéance ${due.next_due_date}) : traçabilité dégradée.`,
      details: { next_due_date: due.next_due_date, days_overdue: due.days_overdue },
    });
    return;
  }

  reasons.push({
    code: critical ? "INSTRUMENT_OVERDUE_CRITICAL" : "INSTRUMENT_OVERDUE",
    severity: blocking ? "BLOCKING" : "WARNING",
    message: blocking
      ? `Instrument ${critical ? "critique " : ""}en retard d'étalonnage (échéance ${due.next_due_date}, ${due.days_overdue} j) : usage bloqué.`
      : `Étalonnage dépassé depuis ${due.days_overdue} j (échéance ${due.next_due_date}) : traçabilité dégradée.`,
    details: {
      next_due_date: due.next_due_date,
      days_overdue: due.days_overdue,
      criticite: instrument.criticite,
      blocking_strategy: strategy,
      setting_applied: critical && policy.block_on_overdue_critical,
    },
  });
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function ok(message: string, due: DueEvaluation): MetrologyEligibility {
  return { eligible: true, severity: "OK", code: "OK", message, reasons: [], due };
}

function decide(reasons: EligibilityReason[], due: DueEvaluation): MetrologyEligibility {
  const blocking = reasons.find((reason) => reason.severity === "BLOCKING");
  if (blocking) {
    return {
      eligible: false,
      severity: "BLOCKING",
      code: blocking.code,
      message: blocking.message,
      reasons,
      due,
    };
  }
  const warning = reasons.find((reason) => reason.severity === "WARNING");
  if (warning) {
    return {
      eligible: true,
      severity: "WARNING",
      code: warning.code,
      message: warning.message,
      reasons,
      due,
    };
  }
  return { eligible: true, severity: "OK", code: "OK", message: "Instrument valide.", reasons, due };
}

/* -------------------------------------------------------------------------- */
/* 4) Snapshot immuable                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Photographie figée écrite dans le résultat qualité. Elle protège l'historique :
 * une modification ultérieure du registre, du plan ou du certificat ne réécrit
 * PAS le contrôle déjà exécuté.
 *
 * Elle ne contient jamais de `storage_path`, de chemin local, de jeton ni de
 * donnée personnelle : uniquement des identifiants et des valeurs métier.
 */
export type MetrologyInstrumentSnapshot = {
  snapshot_version: 2;
  instrument_id: string;
  code: string | null;
  designation: string | null;
  categorie_code: string | null;
  etat: MetrologyEquipmentState;
  criticite: string | null;
  eligibility_code: MetrologyEligibilityCode;
  eligibility_severity: EligibilitySeverity;
  eligible: boolean;
  plan_version_id: string | null;
  plan_version: number | null;
  next_due_date: string | null;
  days_overdue: number;
  last_proof_execution_id: string | null;
  last_proof_date: string | null;
  last_proof_verdict: string | null;
  certificate_id: string | null;
  unite: string | null;
  plage_min: number | null;
  plage_max: number | null;
  resolution: number | null;
  mpe: number | null;
  incertitude: number | null;
  used_at: string;
  reasons: Array<Pick<EligibilityReason, "code" | "severity" | "message">>;
};

export function buildInstrumentSnapshot(params: {
  instrument: MetrologyInstrumentState;
  eligibility: MetrologyEligibility;
  at: Date;
}): MetrologyInstrumentSnapshot {
  const { instrument, eligibility, at } = params;
  return {
    snapshot_version: 2,
    instrument_id: instrument.id,
    code: instrument.code,
    designation: instrument.designation,
    categorie_code: instrument.categorie_code ?? instrument.categorie_legacy,
    etat: instrument.etat,
    criticite: instrument.criticite === null ? null : String(instrument.criticite),
    eligibility_code: eligibility.code,
    eligibility_severity: eligibility.severity,
    eligible: eligibility.eligible,
    plan_version_id: instrument.plan_version_id,
    plan_version: instrument.plan_version,
    next_due_date: instrument.next_due_date,
    days_overdue: eligibility.due.days_overdue,
    last_proof_execution_id: instrument.last_proof_execution_id,
    last_proof_date: instrument.last_proof_date,
    last_proof_verdict: instrument.last_proof_verdict,
    certificate_id: instrument.certificate_id,
    unite: instrument.unite,
    plage_min: instrument.plage_min,
    plage_max: instrument.plage_max,
    resolution: instrument.resolution,
    mpe: instrument.mpe,
    incertitude: instrument.incertitude,
    used_at: at.toISOString(),
    reasons: eligibility.reasons.map((reason) => ({
      code: reason.code,
      severity: reason.severity,
      message: reason.message,
    })),
  };
}
