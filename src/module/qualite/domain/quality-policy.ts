// Gouvernance Qualité 360 (#228) — politiques pures, sans I/O.
//
// Ce fichier concentre les règles qui ne doivent jamais dépendre d'un appel
// réseau, d'un client SQL ou du navigateur : capacités RBAC, cycles de vie,
// séparation des tâches, idempotence et empreinte canonique des snapshots.
//
// Compatibilité : les enums historiques du module Qualité (#0 patchs
// `20260213_qualite_module.sql` / `20260226_qualite_complete_ncr_capa_stock.sql`)
// sont conservés et étendus, jamais remplacés par une seconde nomenclature.

import crypto from "node:crypto";

import { HttpError } from "../../../utils/httpError";

/* -------------------------------------------------------------------------- */
/* 1) Capacités RBAC — refus par défaut                                       */
/* -------------------------------------------------------------------------- */

export const QUALITY_CAPABILITIES = [
  "read",
  "referential_manage",
  "plan_publish",
  "execution_run",
  "measurement_write",
  "release_decide",
  "disposition_stock",
  "nc_manage",
  "capa_manage",
  "derogation_request",
  "derogation_approve",
  "closure_verify",
  "documents_read",
  "audit_read",
  "settings_manage",
] as const;

export type QualityCapability = (typeof QUALITY_CAPABILITIES)[number];

// Les rôles CERP sont du texte libre en base ; on garde la mécanique par
// « needles » déjà utilisée par `of-rbac.ts` et `machine-rbac.ts` au lieu
// d'inventer une table de rôles parallèle.
const CAPABILITY_NEEDLES: Record<QualityCapability, readonly string[]> = {
  // Lecture qualité : qualité, direction, production/atelier et méthodes en ont
  // besoin pour travailler, mais elle reste fermée aux autres rôles.
  read: [
    "admin",
    "administrateur",
    "directeur",
    "qualit",
    "quality",
    "qse",
    "production",
    "atelier",
    "method",
    "logisti",
  ],
  referential_manage: ["admin", "administrateur", "directeur", "qualit", "quality", "qse", "method"],
  plan_publish: ["admin", "administrateur", "directeur", "qualit", "quality", "qse"],
  execution_run: ["admin", "administrateur", "directeur", "qualit", "quality", "qse", "production", "atelier"],
  measurement_write: ["admin", "administrateur", "directeur", "qualit", "quality", "qse", "production", "atelier"],
  release_decide: ["admin", "administrateur", "directeur", "qualit", "quality", "qse"],
  disposition_stock: ["admin", "administrateur", "directeur", "qualit", "quality", "qse"],
  nc_manage: ["admin", "administrateur", "directeur", "qualit", "quality", "qse"],
  capa_manage: ["admin", "administrateur", "directeur", "qualit", "quality", "qse"],
  derogation_request: ["admin", "administrateur", "directeur", "qualit", "quality", "qse", "method", "production"],
  derogation_approve: ["admin", "administrateur", "directeur", "qualit", "quality", "qse"],
  closure_verify: ["admin", "administrateur", "directeur", "qualit", "quality", "qse"],
  documents_read: ["admin", "administrateur", "directeur", "qualit", "quality", "qse", "production", "atelier", "method"],
  audit_read: ["admin", "administrateur", "directeur", "qualit", "quality", "qse"],
  settings_manage: ["admin", "administrateur", "directeur"],
};

export function roleHasQualityCapability(
  role: string | null | undefined,
  capability: QualityCapability
): boolean {
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return false;
  const needles = CAPABILITY_NEEDLES[capability];
  if (!needles) return false;
  return needles.some((needle) => normalized.includes(needle));
}

export function assertQualityCapability(
  role: string | null | undefined,
  capability: QualityCapability
): void {
  if (!roleHasQualityCapability(role, capability)) {
    throw new HttpError(
      403,
      "QUALITY_CAPABILITY_REQUIRED",
      `La capacité Qualité '${capability}' est requise.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 2) Plans de contrôle — cycle de vie et immuabilité                         */
/* -------------------------------------------------------------------------- */

export const QUALITY_PLAN_STATUSES = ["DRAFT", "IN_REVIEW", "PUBLISHED", "ARCHIVED"] as const;
export type QualityPlanStatus = (typeof QUALITY_PLAN_STATUSES)[number];

const PLAN_TRANSITIONS: Readonly<Record<QualityPlanStatus, readonly QualityPlanStatus[]>> = {
  DRAFT: ["IN_REVIEW", "PUBLISHED", "ARCHIVED"],
  IN_REVIEW: ["DRAFT", "PUBLISHED", "ARCHIVED"],
  // Un plan publié est immuable : on l'archive, on ne le rouvre pas.
  PUBLISHED: ["ARCHIVED"],
  ARCHIVED: [],
};

export function assertPlanTransition(from: QualityPlanStatus, to: QualityPlanStatus): void {
  if (!PLAN_TRANSITIONS[from]?.includes(to)) {
    throw new HttpError(
      409,
      "QUALITY_PLAN_TRANSITION_FORBIDDEN",
      `Transition de plan de contrôle interdite : ${from} vers ${to}.`
    );
  }
}

export function assertPlanContentMutable(status: QualityPlanStatus): void {
  if (status !== "DRAFT" && status !== "IN_REVIEW") {
    throw new HttpError(
      409,
      "QUALITY_PLAN_IMMUTABLE",
      "Un plan publié ou archivé ne se modifie pas : créez une nouvelle version."
    );
  }
}

export function assertPlanSelectableForExecution(status: QualityPlanStatus): void {
  if (status !== "PUBLISHED") {
    throw new HttpError(
      409,
      "QUALITY_PLAN_NOT_PUBLISHED",
      "Seul un plan de contrôle publié peut être appliqué à une exécution."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 3) Exécutions de contrôle — statuts et verdicts                            */
/* -------------------------------------------------------------------------- */

export const QUALITY_EXECUTION_STATUSES = [
  "PLANNED",
  "IN_PROGRESS",
  "VALIDATED",
  "REJECTED",
] as const;
export type QualityExecutionStatus = (typeof QUALITY_EXECUTION_STATUSES)[number];

export const QUALITY_VERDICTS = ["CONFORME", "NON_CONFORME", "PARTIEL", "EN_ATTENTE"] as const;
export type QualityVerdict = (typeof QUALITY_VERDICTS)[number];

// Mapping canonique vers l'enum historique `quality_control_result` (OK/NOK/PARTIAL)
// pour ne pas casser les listes, KPI et écrans déjà en production.
export function verdictToLegacyResult(verdict: QualityVerdict): "OK" | "NOK" | "PARTIAL" | null {
  switch (verdict) {
    case "CONFORME":
      return "OK";
    case "NON_CONFORME":
      return "NOK";
    case "PARTIEL":
      return "PARTIAL";
    case "EN_ATTENTE":
      return null;
  }
}

export function legacyResultToVerdict(
  result: "OK" | "NOK" | "PARTIAL" | null | undefined
): QualityVerdict {
  switch (result) {
    case "OK":
      return "CONFORME";
    case "NOK":
      return "NON_CONFORME";
    case "PARTIAL":
      return "PARTIEL";
    default:
      return "EN_ATTENTE";
  }
}

export function executionStatusForVerdict(verdict: QualityVerdict): QualityExecutionStatus {
  if (verdict === "EN_ATTENTE") return "IN_PROGRESS";
  return verdict === "CONFORME" ? "VALIDATED" : "REJECTED";
}

/* -------------------------------------------------------------------------- */
/* 4) Non-conformités — cycle de vie étendu                                   */
/* -------------------------------------------------------------------------- */

// L'enum PostgreSQL `quality_nc_status` est étendu de façon additive par le
// patch #228 : les 4 valeurs historiques restent en tête.
export const QUALITY_NC_STATUSES = [
  "OPEN",
  "ANALYSIS",
  "ACTION_PLAN",
  "CLOSED",
  "DRAFT",
  "DISPOSITION",
  "VERIFICATION",
  "CANCELLED",
] as const;
export type QualityNcStatus = (typeof QUALITY_NC_STATUSES)[number];

const NC_TRANSITIONS: Readonly<Record<QualityNcStatus, readonly QualityNcStatus[]>> = {
  DRAFT: ["OPEN", "CANCELLED"],
  OPEN: ["ANALYSIS", "DISPOSITION", "CANCELLED"],
  ANALYSIS: ["DISPOSITION", "ACTION_PLAN", "OPEN", "CANCELLED"],
  DISPOSITION: ["ACTION_PLAN", "VERIFICATION", "ANALYSIS", "CANCELLED"],
  ACTION_PLAN: ["VERIFICATION", "DISPOSITION", "CANCELLED"],
  VERIFICATION: ["CLOSED", "ACTION_PLAN"],
  // Une NC clôturée se réouvre par action auditée, jamais par simple édition.
  CLOSED: ["OPEN"],
  CANCELLED: [],
};

export function assertNcTransition(from: QualityNcStatus, to: QualityNcStatus): void {
  if (!NC_TRANSITIONS[from]?.includes(to)) {
    throw new HttpError(
      409,
      "QUALITY_NC_TRANSITION_FORBIDDEN",
      `Transition de non-conformité interdite : ${from} vers ${to}.`
    );
  }
}

export type NcClosurePrecondition = {
  hasDisposition: boolean;
  mandatoryCapaCount: number;
  verifiedCapaCount: number;
  hasRootCause: boolean;
  hasEffectivenessEvidence: boolean;
};

// Une NC ne se clôture pas parce qu'un champ texte est rempli : on exige la
// disposition, la cause et la vérification d'efficacité des CAPA obligatoires.
export function assertNcClosureAllowed(pre: NcClosurePrecondition): void {
  const missing: string[] = [];
  if (!pre.hasDisposition) missing.push("disposition");
  if (!pre.hasRootCause) missing.push("root_cause");
  if (pre.mandatoryCapaCount > 0 && pre.verifiedCapaCount < pre.mandatoryCapaCount) {
    missing.push("capa_verification");
  }
  if (!pre.hasEffectivenessEvidence) missing.push("effectiveness_evidence");
  if (missing.length > 0) {
    throw new HttpError(
      422,
      "QUALITY_NC_CLOSURE_INCOMPLETE",
      "Clôture impossible : éléments obligatoires manquants.",
      { missing }
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 5) Dispositions qualité                                                    */
/* -------------------------------------------------------------------------- */

// Types historiques conservés à l'identique (contrainte CHECK #0226) + reprise
// de contrôle demandée par #228.
export const QUALITY_DISPOSITION_TYPES = [
  "HOLD",
  "RELEASE",
  "USE_AS_IS",
  "REWORK",
  "SORT",
  "SCRAP",
  "RETURN_SUPPLIER",
  "RECHECK",
] as const;
export type QualityDispositionType = (typeof QUALITY_DISPOSITION_TYPES)[number];

// Seules ces dispositions écrivent un mouvement de stock : elles exigent
// preview + Idempotency-Key + transaction.
const STOCK_IMPACTING: ReadonlySet<QualityDispositionType> = new Set<QualityDispositionType>([
  "SCRAP",
  "RETURN_SUPPLIER",
]);

export function dispositionImpactsStock(type: QualityDispositionType): boolean {
  return STOCK_IMPACTING.has(type);
}

// `USE_AS_IS` est une acceptation en l'état : elle exige une dérogation active.
export function dispositionRequiresDerogation(type: QualityDispositionType): boolean {
  return type === "USE_AS_IS";
}

export function dispositionRequiresQuantity(type: QualityDispositionType): boolean {
  return type !== "RECHECK";
}

/* -------------------------------------------------------------------------- */
/* 6) Dérogations / concessions                                               */
/* -------------------------------------------------------------------------- */

export const QUALITY_DEROGATION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "CONSUMED",
  "EXPIRED",
  "REVOKED",
] as const;
export type QualityDerogationStatus = (typeof QUALITY_DEROGATION_STATUSES)[number];

const DEROGATION_TRANSITIONS: Readonly<
  Record<QualityDerogationStatus, readonly QualityDerogationStatus[]>
> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["APPROVED", "REJECTED", "DRAFT"],
  APPROVED: ["CONSUMED", "EXPIRED", "REVOKED"],
  REJECTED: [],
  CONSUMED: ["REVOKED"],
  EXPIRED: [],
  REVOKED: [],
};

export function assertDerogationTransition(
  from: QualityDerogationStatus,
  to: QualityDerogationStatus
): void {
  if (!DEROGATION_TRANSITIONS[from]?.includes(to)) {
    throw new HttpError(
      409,
      "QUALITY_DEROGATION_TRANSITION_FORBIDDEN",
      `Transition de dérogation interdite : ${from} vers ${to}.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 7) Séparation des tâches                                                   */
/* -------------------------------------------------------------------------- */

export type SeparationPolicy = {
  // Exception explicitement configurée, justifiée et auditée (jamais implicite).
  allowSelfRelease: boolean;
  allowSelfDerogationApproval: boolean;
};

export const DEFAULT_SEPARATION_POLICY: SeparationPolicy = {
  allowSelfRelease: false,
  allowSelfDerogationApproval: false,
};

export function assertReleaseSeparation(params: {
  executorUserId: number | null;
  deciderUserId: number;
  policy?: SeparationPolicy;
}): void {
  const policy = params.policy ?? DEFAULT_SEPARATION_POLICY;
  if (policy.allowSelfRelease) return;
  if (params.executorUserId !== null && params.executorUserId === params.deciderUserId) {
    throw new HttpError(
      403,
      "QUALITY_SEPARATION_OF_DUTIES",
      "L'auteur de l'exécution ne peut pas prononcer lui-même la libération."
    );
  }
}

export function assertDerogationApprovalSeparation(params: {
  requesterUserId: number | null;
  approverUserId: number;
  policy?: SeparationPolicy;
}): void {
  const policy = params.policy ?? DEFAULT_SEPARATION_POLICY;
  if (policy.allowSelfDerogationApproval) return;
  if (params.requesterUserId !== null && params.requesterUserId === params.approverUserId) {
    throw new HttpError(
      403,
      "QUALITY_SEPARATION_OF_DUTIES",
      "Le demandeur ne peut pas approuver sa propre dérogation."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 8) Verdict manuel contraire au calcul                                      */
/* -------------------------------------------------------------------------- */

export type ManualVerdictOverride = {
  computed: QualityVerdict;
  requested: QualityVerdict;
  justification: string | null;
  evidenceCount: number;
  requireEvidence: boolean;
};

export function assertManualVerdictOverride(input: ManualVerdictOverride): void {
  if (input.requested === input.computed) return;
  const justification = (input.justification ?? "").trim();
  if (justification.length < 20) {
    throw new HttpError(
      422,
      "QUALITY_VERDICT_OVERRIDE_JUSTIFICATION_REQUIRED",
      "Un verdict contraire au calcul exige une justification d'au moins 20 caractères."
    );
  }
  if (input.requireEvidence && input.evidenceCount <= 0) {
    throw new HttpError(
      422,
      "QUALITY_VERDICT_OVERRIDE_EVIDENCE_REQUIRED",
      "Un verdict contraire au calcul exige au moins une pièce jointe de preuve."
    );
  }
  // Un verdict manuel ne peut pas transformer une non-conformité en conformité
  // sans passer par une dérogation : c'est le rôle de la concession, pas du
  // contrôleur.
  if (input.computed === "NON_CONFORME" && input.requested === "CONFORME") {
    throw new HttpError(
      422,
      "QUALITY_VERDICT_OVERRIDE_FORBIDDEN",
      "Un résultat non conforme ne devient pas conforme par décision manuelle : utilisez une dérogation."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 9) Idempotence et empreinte canonique                                      */
/* -------------------------------------------------------------------------- */

export function normalizeQualityIdempotencyKey(value: string | null | undefined): string {
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

export function qualitySha256(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function qualityRequestHash(commandType: string, payload: unknown): string {
  return qualitySha256({ command_type: commandType, payload });
}

export function decideQualityReceipt(
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
      "QUALITY_PREVIEW_REQUIRED",
      "Un aperçu serveur est obligatoire avant de confirmer cette décision."
    );
  }
  if (expected !== params.currentHash) {
    throw new HttpError(
      409,
      "QUALITY_PREVIEW_STALE",
      "L'aperçu n'est plus à jour : rechargez-le avant de confirmer."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 10) Verrou optimiste                                                       */
/* -------------------------------------------------------------------------- */

export function assertOptimisticVersion(params: {
  expectedUpdatedAt: string | null | undefined;
  currentUpdatedAt: string | Date;
}): void {
  const expected = (params.expectedUpdatedAt ?? "").trim();
  if (!expected) {
    throw new HttpError(
      422,
      "QUALITY_EXPECTED_VERSION_REQUIRED",
      "expected_updated_at est obligatoire pour modifier cet objet qualité."
    );
  }
  const current =
    params.currentUpdatedAt instanceof Date
      ? params.currentUpdatedAt.toISOString()
      : new Date(params.currentUpdatedAt).toISOString();
  const parsedExpected = new Date(expected);
  if (Number.isNaN(parsedExpected.getTime())) {
    throw new HttpError(422, "QUALITY_EXPECTED_VERSION_INVALID", "expected_updated_at est invalide.");
  }
  if (parsedExpected.toISOString() !== current) {
    throw new HttpError(
      409,
      "QUALITY_VERSION_CONFLICT",
      "Cet objet qualité a été modifié entre-temps : rechargez la fiche."
    );
  }
}
