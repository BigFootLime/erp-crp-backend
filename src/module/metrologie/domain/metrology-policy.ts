// Gouvernance Métrologie 360 (#229) — politiques pures, sans I/O.
//
// Ce fichier concentre les règles qui ne doivent jamais dépendre d'un appel
// réseau, d'un client SQL ou du navigateur : capacités RBAC, cycles de vie,
// séparation des tâches, idempotence et empreinte canonique.
//
// Compatibilité : les enums historiques du module Métrologie (patch
// `20260227_metrologie_calibration.sql`) sont CONSERVÉS et étendus. `statut`
// (ACTIF/INACTIF/REBUT) reste la vue héritée ; `etat` est l'état de gouvernance
// introduit par #229 et tenu cohérent par trigger.

import crypto from "node:crypto";

import { HttpError } from "../../../utils/httpError";

/* -------------------------------------------------------------------------- */
/* 1) Capacités RBAC — refus par défaut                                       */
/* -------------------------------------------------------------------------- */

export const METROLOGY_CAPABILITIES = [
  "read",
  "categories_manage",
  "equipment_write",
  "plan_manage",
  "execution_record",
  "verdict_validate",
  "documents_read",
  "documents_write",
  "quarantine_set",
  "repair_manage",
  "equipment_release",
  "impact_read",
  "impact_create",
  "impact_decide",
  "settings_manage",
  "audit_read",
] as const;

export type MetrologyCapability = (typeof METROLOGY_CAPABILITIES)[number];

// Les rôles CERP sont du texte libre en base : on garde la mécanique par
// « needles » déjà utilisée par `quality-policy.ts`, `of-rbac.ts` et
// `machine-rbac.ts` plutôt que d'inventer une table de rôles parallèle.
//
// Aucun rôle n'obtient de droit implicite : Qualité, Métrologie, Production,
// Magasin, ADV et Finance n'apparaissent que là où le métier l'exige.
const CAPABILITY_NEEDLES: Record<MetrologyCapability, readonly string[]> = {
  // Lire le parc est nécessaire pour choisir un instrument en atelier.
  read: [
    "admin",
    "administrateur",
    "directeur",
    "metrolog",
    "métrolog",
    "qualit",
    "quality",
    "qse",
    "production",
    "atelier",
    "method",
  ],
  categories_manage: ["admin", "administrateur", "directeur", "metrolog", "métrolog", "qualit", "quality", "qse"],
  equipment_write: ["admin", "administrateur", "directeur", "metrolog", "métrolog", "qualit", "quality", "qse", "method"],
  plan_manage: ["admin", "administrateur", "directeur", "metrolog", "métrolog", "qualit", "quality", "qse"],
  // L'atelier peut relever une vérification interne ; il ne la valide pas.
  execution_record: [
    "admin",
    "administrateur",
    "directeur",
    "metrolog",
    "métrolog",
    "qualit",
    "quality",
    "qse",
    "production",
    "atelier",
  ],
  verdict_validate: ["admin", "administrateur", "directeur", "metrolog", "métrolog", "qualit", "quality", "qse"],
  documents_read: [
    "admin",
    "administrateur",
    "directeur",
    "metrolog",
    "métrolog",
    "qualit",
    "quality",
    "qse",
    "production",
    "atelier",
    "method",
  ],
  documents_write: ["admin", "administrateur", "directeur", "metrolog", "métrolog", "qualit", "quality", "qse"],
  quarantine_set: [
    "admin",
    "administrateur",
    "directeur",
    "metrolog",
    "métrolog",
    "qualit",
    "quality",
    "qse",
    "production",
    "atelier",
  ],
  repair_manage: ["admin", "administrateur", "directeur", "metrolog", "métrolog", "qualit", "quality", "qse", "method"],
  // Remettre un instrument en service est un acte de libération : jamais l'atelier.
  equipment_release: ["admin", "administrateur", "directeur", "metrolog", "métrolog", "qualit", "quality", "qse"],
  impact_read: ["admin", "administrateur", "directeur", "metrolog", "métrolog", "qualit", "quality", "qse", "method"],
  impact_create: ["admin", "administrateur", "directeur", "metrolog", "métrolog", "qualit", "quality", "qse"],
  impact_decide: ["admin", "administrateur", "directeur", "qualit", "quality", "qse"],
  settings_manage: ["admin", "administrateur", "directeur"],
  audit_read: ["admin", "administrateur", "directeur", "metrolog", "métrolog", "qualit", "quality", "qse"],
};

export function roleHasMetrologyCapability(
  role: string | null | undefined,
  capability: MetrologyCapability
): boolean {
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return false;
  const needles = CAPABILITY_NEEDLES[capability];
  if (!needles) return false;
  return needles.some((needle) => normalized.includes(needle));
}

export function assertMetrologyCapability(
  role: string | null | undefined,
  capability: MetrologyCapability
): void {
  if (!roleHasMetrologyCapability(role, capability)) {
    throw new HttpError(
      403,
      "METROLOGY_CAPABILITY_REQUIRED",
      `La capacité Métrologie '${capability}' est requise.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 2) États d'équipement — machine à états serveur                            */
/* -------------------------------------------------------------------------- */

// États STOCKÉS (gouvernance). `DUE_SOON` et `OVERDUE` ne sont volontairement
// pas stockés : ce sont des dérivés du plan actif et de la date du jour, calculés
// à chaque lecture pour ne jamais dériver de la réalité (cf. `metrology-schedule`).
export const METROLOGY_EQUIPMENT_STATES = [
  "DRAFT",
  "ACTIVE",
  "QUALIFIED",
  "SUSPENDED",
  "QUARANTINE",
  "OUT_OF_TOLERANCE",
  "UNDER_REPAIR",
  "RETIRED",
] as const;
export type MetrologyEquipmentState = (typeof METROLOGY_EQUIPMENT_STATES)[number];

// État EFFECTIF exposé à l'UI : état stocké enrichi des dérivés d'échéance.
export const METROLOGY_EFFECTIVE_STATES = [
  ...METROLOGY_EQUIPMENT_STATES,
  "DUE_SOON",
  "OVERDUE",
] as const;
export type MetrologyEffectiveState = (typeof METROLOGY_EFFECTIVE_STATES)[number];

const EQUIPMENT_TRANSITIONS: Readonly<
  Record<MetrologyEquipmentState, readonly MetrologyEquipmentState[]>
> = {
  DRAFT: ["ACTIVE", "QUALIFIED", "RETIRED"],
  ACTIVE: ["QUALIFIED", "SUSPENDED", "QUARANTINE", "OUT_OF_TOLERANCE", "UNDER_REPAIR", "RETIRED"],
  QUALIFIED: ["ACTIVE", "SUSPENDED", "QUARANTINE", "OUT_OF_TOLERANCE", "UNDER_REPAIR", "RETIRED"],
  SUSPENDED: ["ACTIVE", "QUALIFIED", "QUARANTINE", "UNDER_REPAIR", "RETIRED"],
  // Sortir de quarantaine passe par une réparation/ajustage ou par une
  // libération explicite, jamais par un simple changement de statut.
  QUARANTINE: ["UNDER_REPAIR", "OUT_OF_TOLERANCE", "QUALIFIED", "RETIRED"],
  OUT_OF_TOLERANCE: ["UNDER_REPAIR", "QUARANTINE", "QUALIFIED", "RETIRED"],
  UNDER_REPAIR: ["QUARANTINE", "QUALIFIED", "RETIRED"],
  RETIRED: [],
};

// Une remise en service (retour vers un état utilisable) exige une preuve
// conforme valide ET la capacité `equipment_release`.
const RELEASE_TARGETS: ReadonlySet<MetrologyEquipmentState> = new Set<MetrologyEquipmentState>([
  "ACTIVE",
  "QUALIFIED",
]);

const BLOCKED_STATES: ReadonlySet<MetrologyEquipmentState> = new Set<MetrologyEquipmentState>([
  "DRAFT",
  "SUSPENDED",
  "QUARANTINE",
  "OUT_OF_TOLERANCE",
  "UNDER_REPAIR",
  "RETIRED",
]);

export function equipmentStateBlocksUsage(state: MetrologyEquipmentState): boolean {
  return BLOCKED_STATES.has(state);
}

export function assertEquipmentTransition(
  from: MetrologyEquipmentState,
  to: MetrologyEquipmentState
): void {
  if (from === to) {
    throw new HttpError(
      409,
      "METROLOGY_EQUIPMENT_TRANSITION_NOOP",
      `L'équipement est déjà dans l'état ${from}.`
    );
  }
  if (!EQUIPMENT_TRANSITIONS[from]?.includes(to)) {
    throw new HttpError(
      409,
      "METROLOGY_EQUIPMENT_TRANSITION_FORBIDDEN",
      `Transition d'équipement interdite : ${from} vers ${to}.`
    );
  }
}

export function transitionRequiresRelease(
  from: MetrologyEquipmentState,
  to: MetrologyEquipmentState
): boolean {
  if (!RELEASE_TARGETS.has(to)) return false;
  return from === "QUARANTINE" || from === "OUT_OF_TOLERANCE" || from === "UNDER_REPAIR";
}

export type ReleasePrecondition = {
  hasValidConformeProof: boolean;
  proofExecutionId: string | null;
  repairRequired: boolean;
  repairDone: boolean;
  reason: string | null;
};

/**
 * Remise en service : jamais une simple modification de statut. Il faut la
 * réparation/ajustage quand elle a été exigée, une preuve conforme valide, et
 * un motif écrit conservé dans l'audit.
 */
export function assertEquipmentReleaseAllowed(pre: ReleasePrecondition): void {
  const missing: string[] = [];
  if (pre.repairRequired && !pre.repairDone) missing.push("repair_or_adjustment");
  if (!pre.hasValidConformeProof || !pre.proofExecutionId) missing.push("conforming_proof");
  if ((pre.reason ?? "").trim().length < 10) missing.push("reason");
  if (missing.length > 0) {
    throw new HttpError(
      422,
      "METROLOGY_RELEASE_INCOMPLETE",
      "Remise en service impossible : éléments obligatoires manquants.",
      { missing }
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 3) Plans versionnés — cycle de vie et immuabilité                          */
/* -------------------------------------------------------------------------- */

export const METROLOGY_PLAN_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export type MetrologyPlanStatus = (typeof METROLOGY_PLAN_STATUSES)[number];

const PLAN_TRANSITIONS: Readonly<Record<MetrologyPlanStatus, readonly MetrologyPlanStatus[]>> = {
  DRAFT: ["ACTIVE", "ARCHIVED"],
  // Une version active est figée : on l'archive en publiant sa remplaçante.
  ACTIVE: ["ARCHIVED"],
  ARCHIVED: [],
};

export function assertPlanTransition(from: MetrologyPlanStatus, to: MetrologyPlanStatus): void {
  if (!PLAN_TRANSITIONS[from]?.includes(to)) {
    throw new HttpError(
      409,
      "METROLOGY_PLAN_TRANSITION_FORBIDDEN",
      `Transition de plan métrologique interdite : ${from} vers ${to}.`
    );
  }
}

export function assertPlanContentMutable(status: MetrologyPlanStatus): void {
  if (status !== "DRAFT") {
    throw new HttpError(
      409,
      "METROLOGY_PLAN_IMMUTABLE",
      "Une version de plan active ou archivée ne se modifie pas : créez une nouvelle version."
    );
  }
}

export function assertPlanSelectableForExecution(status: MetrologyPlanStatus): void {
  if (status !== "ACTIVE") {
    throw new HttpError(
      409,
      "METROLOGY_PLAN_NOT_ACTIVE",
      "Seule une version de plan active peut porter un étalonnage ou une vérification."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 4) Exécutions — types, statuts et verdicts                                 */
/* -------------------------------------------------------------------------- */

export const METROLOGY_OPERATION_TYPES = [
  "ETALONNAGE",
  "VERIFICATION",
  "AJUSTAGE",
  "REPARATION",
] as const;
export type MetrologyOperationType = (typeof METROLOGY_OPERATION_TYPES)[number];

export const METROLOGY_EXECUTION_STATUSES = [
  "DRAFT",
  "IN_PROGRESS",
  "VALIDATED",
  "CANCELLED",
] as const;
export type MetrologyExecutionStatus = (typeof METROLOGY_EXECUTION_STATUSES)[number];

export const METROLOGY_VERDICTS = [
  "CONFORME",
  "NON_CONFORME",
  "CONFORME_AVEC_RESTRICTION",
  "INCONCLU",
] as const;
export type MetrologyVerdict = (typeof METROLOGY_VERDICTS)[number];

/**
 * Mapping canonique vers l'enum historique `metrologie_certificats.resultat`
 * (CONFORME/NON_CONFORME/AJUSTAGE), pour ne casser ni la liste des certificats
 * ni les écrans déjà en production.
 */
export function verdictToLegacyCertificatResult(
  verdict: MetrologyVerdict,
  operationType: MetrologyOperationType
): "CONFORME" | "NON_CONFORME" | "AJUSTAGE" {
  if (operationType === "AJUSTAGE" || operationType === "REPARATION") return "AJUSTAGE";
  switch (verdict) {
    case "CONFORME":
    case "CONFORME_AVEC_RESTRICTION":
      return "CONFORME";
    case "NON_CONFORME":
      return "NON_CONFORME";
    case "INCONCLU":
      // Un résultat non concluant n'est pas une conformité : il reste bloquant
      // côté éligibilité, et il est tracé comme non conforme côté certificat.
      return "NON_CONFORME";
  }
}

/** Une exécution qui produit une preuve d'aptitude opposable. */
export function verdictIsAdmissibleProof(verdict: MetrologyVerdict): boolean {
  return verdict === "CONFORME" || verdict === "CONFORME_AVEC_RESTRICTION";
}

/** Un verdict qui déclenche quarantaine + analyse d'impact. */
export function verdictTriggersQuarantine(verdict: MetrologyVerdict): boolean {
  return verdict === "NON_CONFORME";
}

const EXECUTION_TRANSITIONS: Readonly<
  Record<MetrologyExecutionStatus, readonly MetrologyExecutionStatus[]>
> = {
  DRAFT: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["VALIDATED", "CANCELLED"],
  VALIDATED: [],
  CANCELLED: [],
};

export function assertExecutionTransition(
  from: MetrologyExecutionStatus,
  to: MetrologyExecutionStatus
): void {
  if (!EXECUTION_TRANSITIONS[from]?.includes(to)) {
    throw new HttpError(
      409,
      "METROLOGY_EXECUTION_TRANSITION_FORBIDDEN",
      `Transition d'exécution interdite : ${from} vers ${to}.`
    );
  }
}

export function assertExecutionMutable(status: MetrologyExecutionStatus): void {
  if (status === "VALIDATED") {
    throw new HttpError(
      409,
      "METROLOGY_EXECUTION_IMMUTABLE",
      "Une exécution validée est immuable : elle ne se réécrit pas."
    );
  }
  if (status === "CANCELLED") {
    throw new HttpError(
      409,
      "METROLOGY_EXECUTION_CANCELLED",
      "Une exécution annulée ne se rouvre pas."
    );
  }
}

export type ManualVerdictOverride = {
  computed: MetrologyVerdict;
  requested: MetrologyVerdict;
  justification: string | null;
  evidenceCount: number;
  requireEvidence: boolean;
};

/**
 * Un verdict retenu contraire au calcul est possible (l'humain décide), mais il
 * est justifié, tracé, et il ne transforme JAMAIS un hors tolérance en
 * conformité : au mieux en conformité avec restriction documentée.
 */
export function assertManualVerdictOverride(input: ManualVerdictOverride): void {
  if (input.requested === input.computed) return;

  const justification = (input.justification ?? "").trim();
  if (justification.length < 20) {
    throw new HttpError(
      422,
      "METROLOGY_VERDICT_OVERRIDE_JUSTIFICATION_REQUIRED",
      "Un verdict contraire au calcul exige une justification d'au moins 20 caractères."
    );
  }
  if (input.requireEvidence && input.evidenceCount <= 0) {
    throw new HttpError(
      422,
      "METROLOGY_VERDICT_OVERRIDE_EVIDENCE_REQUIRED",
      "Un verdict contraire au calcul exige au moins une pièce jointe de preuve."
    );
  }
  if (input.computed === "NON_CONFORME" && input.requested === "CONFORME") {
    throw new HttpError(
      422,
      "METROLOGY_VERDICT_OVERRIDE_FORBIDDEN",
      "Un relevé hors tolérance ne devient pas conforme par décision manuelle : utilisez « conforme avec restriction » et documentez-la."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 5) Séparation des tâches                                                   */
/* -------------------------------------------------------------------------- */

export type SeparationPolicy = {
  // Exception explicitement configurée, justifiée et auditée (jamais implicite).
  allowSelfVerdictValidation: boolean;
  allowSelfRelease: boolean;
};

export const DEFAULT_METROLOGY_SEPARATION: SeparationPolicy = {
  allowSelfVerdictValidation: false,
  allowSelfRelease: false,
};

export function assertVerdictSeparation(params: {
  operatorUserId: number | null;
  validatorUserId: number;
  operationType: MetrologyOperationType;
  policy?: SeparationPolicy;
}): void {
  const policy = params.policy ?? DEFAULT_METROLOGY_SEPARATION;
  if (policy.allowSelfVerdictValidation) return;
  // Un étalonnage externe est validé par l'interne : la séparation ne
  // s'applique qu'aux opérations réellement exécutées en interne.
  if (params.operatorUserId === null) return;
  if (params.operatorUserId === params.validatorUserId) {
    throw new HttpError(
      403,
      "METROLOGY_SEPARATION_OF_DUTIES",
      "L'opérateur qui a exécuté la vérification ne peut pas valider lui-même le verdict."
    );
  }
}

export function assertReleaseSeparation(params: {
  operatorUserId: number | null;
  releaserUserId: number;
  policy?: SeparationPolicy;
}): void {
  const policy = params.policy ?? DEFAULT_METROLOGY_SEPARATION;
  if (policy.allowSelfRelease) return;
  if (params.operatorUserId !== null && params.operatorUserId === params.releaserUserId) {
    throw new HttpError(
      403,
      "METROLOGY_SEPARATION_OF_DUTIES",
      "L'auteur de l'intervention ne peut pas prononcer lui-même la remise en service."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 6) Décisions d'impact                                                      */
/* -------------------------------------------------------------------------- */

export const METROLOGY_IMPACT_DECISIONS = [
  "PENDING",
  "NO_IMPACT",
  "RECHECK",
  "HOLD_LOT",
  "OPEN_NC",
  "REISSUE_DOCUMENT",
  "INFORM_CUSTOMER",
] as const;
export type MetrologyImpactDecision = (typeof METROLOGY_IMPACT_DECISIONS)[number];

/**
 * Aucune décision d'impact n'est automatique. Cette liste dit précisément ce
 * que le module de métrologie a le droit d'écrire lui-même : rien d'autre que
 * la trace de la décision humaine. Annuler un contrôle, déstocker un lot,
 * annuler un BL, créer un avoir ou déclencher un rappel client restent des
 * actions des modules concernés, jamais un effet de bord d'ici.
 */
export const IMPACT_DECISION_SIDE_EFFECTS: Readonly<
  Record<MetrologyImpactDecision, readonly string[]>
> = {
  PENDING: [],
  NO_IMPACT: [],
  RECHECK: [],
  HOLD_LOT: [],
  OPEN_NC: [],
  REISSUE_DOCUMENT: [],
  INFORM_CUSTOMER: [],
};

export function assertImpactDecision(params: {
  decision: MetrologyImpactDecision;
  reason: string | null;
}): void {
  if (params.decision === "PENDING") {
    throw new HttpError(
      422,
      "METROLOGY_IMPACT_DECISION_REQUIRED",
      "Choisissez une décision : « à traiter » n'est pas une décision."
    );
  }
  if ((params.reason ?? "").trim().length < 5) {
    throw new HttpError(
      422,
      "METROLOGY_IMPACT_DECISION_REASON_REQUIRED",
      "Chaque décision d'impact exige un motif écrit."
    );
  }
}

export const METROLOGY_IMPACT_STATUSES = ["OPEN", "IN_REVIEW", "CLOSED", "CANCELLED"] as const;
export type MetrologyImpactStatus = (typeof METROLOGY_IMPACT_STATUSES)[number];

const IMPACT_TRANSITIONS: Readonly<
  Record<MetrologyImpactStatus, readonly MetrologyImpactStatus[]>
> = {
  OPEN: ["IN_REVIEW", "CANCELLED"],
  IN_REVIEW: ["CLOSED", "OPEN", "CANCELLED"],
  CLOSED: [],
  CANCELLED: [],
};

export function assertImpactTransition(
  from: MetrologyImpactStatus,
  to: MetrologyImpactStatus
): void {
  if (!IMPACT_TRANSITIONS[from]?.includes(to)) {
    throw new HttpError(
      409,
      "METROLOGY_IMPACT_TRANSITION_FORBIDDEN",
      `Transition de dossier d'impact interdite : ${from} vers ${to}.`
    );
  }
}

export function assertImpactClosureAllowed(params: {
  pendingItems: number;
  conclusion: string | null;
}): void {
  const missing: string[] = [];
  if (params.pendingItems > 0) missing.push("pending_items");
  if ((params.conclusion ?? "").trim().length < 20) missing.push("conclusion");
  if (missing.length > 0) {
    throw new HttpError(
      422,
      "METROLOGY_IMPACT_CLOSURE_INCOMPLETE",
      "Clôture impossible : chaque usage doit être décidé et la conclusion écrite.",
      { missing, pending_items: params.pendingItems }
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 7) Idempotence et empreinte canonique                                      */
/* -------------------------------------------------------------------------- */

export function normalizeMetrologyIdempotencyKey(value: string | null | undefined): string {
  const normalized = (value ?? "").trim();
  if (normalized.length < 8 || normalized.length > 200) {
    throw new HttpError(
      400,
      "IDEMPOTENCY_KEY_INVALID",
      "Idempotency-Key doit contenir entre 8 et 200 caractères."
    );
  }
  return normalized;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function metrologySha256(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function metrologyRequestHash(commandType: string, payload: unknown): string {
  return metrologySha256({ command_type: commandType, payload });
}

export function decideMetrologyReceipt(
  existingHash: string | null | undefined,
  incomingHash: string
): "NEW" | "REPLAY" | "CONFLICT" {
  if (!existingHash) return "NEW";
  return existingHash === incomingHash ? "REPLAY" : "CONFLICT";
}

export function assertPreviewFresh(params: {
  expectedHash: string | null | undefined;
  currentHash: string;
}): void {
  const expected = (params.expectedHash ?? "").trim();
  if (!expected) {
    throw new HttpError(
      422,
      "METROLOGY_PREVIEW_REQUIRED",
      "Un aperçu serveur est obligatoire avant de confirmer cette décision."
    );
  }
  if (expected !== params.currentHash) {
    throw new HttpError(
      409,
      "METROLOGY_PREVIEW_STALE",
      "L'aperçu n'est plus à jour : rechargez-le avant de confirmer."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 8) Verrou optimiste                                                        */
/* -------------------------------------------------------------------------- */

export function assertOptimisticVersion(params: {
  expectedUpdatedAt: string | null | undefined;
  currentUpdatedAt: string | Date;
}): void {
  const expected = (params.expectedUpdatedAt ?? "").trim();
  if (!expected) {
    throw new HttpError(
      422,
      "METROLOGY_EXPECTED_VERSION_REQUIRED",
      "expected_updated_at est obligatoire pour modifier cet objet métrologique."
    );
  }
  const current =
    params.currentUpdatedAt instanceof Date
      ? params.currentUpdatedAt.toISOString()
      : new Date(params.currentUpdatedAt).toISOString();
  const parsedExpected = new Date(expected);
  if (Number.isNaN(parsedExpected.getTime())) {
    throw new HttpError(
      422,
      "METROLOGY_EXPECTED_VERSION_INVALID",
      "expected_updated_at est invalide."
    );
  }
  if (parsedExpected.toISOString() !== current) {
    throw new HttpError(
      409,
      "METROLOGY_VERSION_CONFLICT",
      "Cet objet métrologique a été modifié entre-temps : rechargez la fiche."
    );
  }
}
