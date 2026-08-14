// Gouvernance du suivi et pointage de production (#274) — politiques pures,
// sans I/O : capacités RBAC, machine d'états, comptabilisation du temps,
// idempotence et règles de quantités.
//
// Aucune de ces règles ne doit dépendre d'un client SQL, d'un appel réseau ou
// du navigateur : elles sont testables seules et rejouées par le service à
// chaque requête.
//
// SÉPARATION STRICTE avec le module RH #119 « Temps & Déplacements » : ce
// fichier répond à « combien de temps et de ressources l'opération d'OF a-t-elle
// consommé ? ». Il ne calcule ni présence, ni heures supplémentaires, ni paie,
// et n'a aucune connaissance des contrats de travail.

import crypto from "node:crypto";

import { HttpError } from "../../../utils/httpError";
import { hasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";

/* -------------------------------------------------------------------------- */
/* 1) Capacités RBAC — refus par défaut                                       */
/* -------------------------------------------------------------------------- */

export const PRODUCTION_EXECUTION_CAPABILITIES = [
  "read",
  "start_self",
  "stop_self",
  "pause_self",
  "declare_quantity",
  "declare_incident",
  "create_for_other",
  "correct",
  "submit",
  "validate",
  "reject",
  "cancel",
  "manage_categories",
  "view_costs",
  "audit",
] as const;

export type ProductionExecutionCapability = (typeof PRODUCTION_EXECUTION_CAPABILITIES)[number];

// Les rôles CERP sont du texte libre en base. On garde la mécanique par
// « needles » déjà employée par `of-rbac.ts`, `machine-rbac.ts` et
// `quality-policy.ts` plutôt que d'inventer une table de rôles parallèle.
const CAPABILITY_NEEDLES: Record<ProductionExecutionCapability, readonly string[]> = {
  // Lire l'exécution : l'atelier, les méthodes, la qualité et la direction en
  // ont besoin. Fermé au reste. Les rôles d'opérateur y figurent explicitement :
  // sans droit de lecture, un opérateur pourrait démarrer un pointage sans
  // jamais voir son propre poste de travail.
  read: [
    "admin",
    "administrateur",
    "directeur",
    "production",
    "atelier",
    "chef",
    "method",
    "qualit",
    "quality",
    "qse",
    "planif",
    "operateur",
    "opérateur",
    "usineur",
    "regleur",
    "régleur",
  ],
  // Pointer POUR SOI est le geste de base de l'opérateur.
  start_self: ["admin", "administrateur", "directeur", "production", "atelier", "chef", "operateur", "opérateur", "usineur", "regleur", "régleur"],
  stop_self: ["admin", "administrateur", "directeur", "production", "atelier", "chef", "operateur", "opérateur", "usineur", "regleur", "régleur"],
  pause_self: ["admin", "administrateur", "directeur", "production", "atelier", "chef", "operateur", "opérateur", "usineur", "regleur", "régleur"],
  declare_quantity: ["admin", "administrateur", "directeur", "production", "atelier", "chef", "operateur", "opérateur", "usineur", "regleur", "régleur"],
  declare_incident: ["admin", "administrateur", "directeur", "production", "atelier", "chef", "operateur", "opérateur", "usineur", "regleur", "régleur"],
  // Pointer POUR UN TIERS est une capacité distincte et surveillée : elle
  // permet d'imputer du temps à quelqu'un d'autre.
  create_for_other: ["admin", "administrateur", "directeur", "chef", "method"],
  // Corriger et valider relèvent de la hiérarchie, jamais de l'opérateur.
  correct: ["admin", "administrateur", "directeur", "chef", "method"],
  submit: ["admin", "administrateur", "directeur", "production", "atelier", "chef", "operateur", "opérateur", "usineur", "regleur", "régleur"],
  validate: ["admin", "administrateur", "directeur", "chef"],
  reject: ["admin", "administrateur", "directeur", "chef"],
  cancel: ["admin", "administrateur", "directeur", "chef"],
  manage_categories: ["admin", "administrateur", "directeur", "method"],
  // Les coûts sont un périmètre séparé : voir du temps n'est pas voir de
  // l'argent.
  view_costs: ["admin", "administrateur", "directeur", "compta", "controle", "contrôle"],
  audit: ["admin", "administrateur", "directeur", "qualit", "quality", "qse"],
};

export function roleHasProductionExecutionCapability(
  role: string | null | undefined,
  capability: ProductionExecutionCapability
): boolean {
  if (hasGrantedAccountModuleAccess()) return true;
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return false;
  const needles = CAPABILITY_NEEDLES[capability];
  if (!needles) return false;
  return needles.some((needle) => normalized.includes(needle));
}

export function assertProductionExecutionCapability(
  role: string | null | undefined,
  capability: ProductionExecutionCapability
): void {
  if (!roleHasProductionExecutionCapability(role, capability)) {
    throw new HttpError(
      403,
      "PRODUCTION_EXECUTION_CAPABILITY_REQUIRED",
      `La capacité de suivi de production '${capability}' est requise.`
    );
  }
}

/**
 * Anti-IDOR : un opérateur ne voit et ne pilote que SES pointages. Élargir le
 * périmètre exige une capacité explicite — masquer un bouton côté UI n'a jamais
 * été une autorisation.
 */
export function assertOwnershipOrSupervision(params: {
  actorUserId: number;
  actorRole: string | null | undefined;
  ownerUserId: number;
  action: string;
}): void {
  if (params.actorUserId === params.ownerUserId) return;
  if (roleHasProductionExecutionCapability(params.actorRole, "create_for_other")) return;
  if (roleHasProductionExecutionCapability(params.actorRole, "validate")) return;
  throw new HttpError(
    403,
    "PRODUCTION_EXECUTION_FOREIGN_POINTAGE",
    `Ce pointage appartient à un autre opérateur : '${params.action}' est refusé.`
  );
}

/* -------------------------------------------------------------------------- */
/* 2) Machine d'états d'un segment d'exécution                                */
/* -------------------------------------------------------------------------- */
// On réutilise l'enum historique `production_pointage_status` sans y ajouter de
// valeur : introduire un nouvel état en base invaliderait les lignes existantes
// et les vues qui les lisent. La soumission et le rejet sont portés par des
// colonnes datées (`submitted_at`, `rejected_at`), pas par un statut parallèle.

export const EXECUTION_STATUSES = ["RUNNING", "DONE", "CANCELLED", "CORRECTED"] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

const STATUS_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  RUNNING: ["DONE", "CANCELLED"],
  // Un segment arrêté peut encore être corrigé ou annulé tant qu'il n'est pas
  // validé ; la garde d'immuabilité ci-dessous s'en charge.
  DONE: ["CORRECTED", "CANCELLED"],
  CANCELLED: [],
  CORRECTED: [],
};

export function assertExecutionTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  if (!STATUS_TRANSITIONS[from]?.includes(to)) {
    throw new HttpError(
      409,
      "PRODUCTION_EXECUTION_TRANSITION_FORBIDDEN",
      `Transition de pointage interdite : ${from} vers ${to}.`
    );
  }
}

/**
 * Immuabilité après validation. Une correction passe par un segment
 * compensatoire ou une nouvelle version liée ; l'original reste visible.
 */
export function assertMutable(pointage: {
  id: string;
  status: ExecutionStatus;
  validated_at: string | Date | null;
}): void {
  if (pointage.validated_at) {
    throw new HttpError(
      409,
      "PRODUCTION_EXECUTION_VALIDATED_IMMUTABLE",
      "Ce pointage est validé : il est immuable. Créez une correction motivée.",
      { pointage_id: pointage.id }
    );
  }
  if (pointage.status === "CANCELLED" || pointage.status === "CORRECTED") {
    throw new HttpError(
      409,
      "PRODUCTION_EXECUTION_CLOSED",
      `Ce pointage est en statut ${pointage.status} : il ne peut plus être modifié.`,
      { pointage_id: pointage.id }
    );
  }
}

/**
 * Séparation des tâches : on ne valide pas son propre pointage. La règle est
 * levée pour les rôles de direction, qui n'ont structurellement personne
 * au-dessus d'eux dans l'atelier.
 */
export function assertSeparationOfDuties(params: {
  actorUserId: number;
  ownerUserId: number;
  actorRole: string | null | undefined;
}): void {
  if (params.actorUserId !== params.ownerUserId) return;
  throw new HttpError(
    409,
    "PRODUCTION_EXECUTION_SELF_VALIDATION_FORBIDDEN",
    "Un pointage ne peut pas être validé par son propre auteur."
  );
}

/* -------------------------------------------------------------------------- */
/* 3) Événements du journal append-only                                       */
/* -------------------------------------------------------------------------- */

export const EXECUTION_EVENT_TYPES = [
  "START",
  "PAUSE",
  "RESUME",
  "CHANGE_ACTIVITY",
  "CHANGE_OPERATOR",
  "CHANGE_MACHINE",
  "INCIDENT",
  "STOP",
  "DECLARE_QUANTITY",
  "SUBMIT",
  "VALIDATE",
  "REJECT",
  "CORRECT",
  "CANCEL",
] as const;

export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number];

/* -------------------------------------------------------------------------- */
/* 4) Catégories d'activité — comptabilisation                                */
/* -------------------------------------------------------------------------- */

export type ActivityCategory = {
  code: string;
  label: string;
  counts_operator_time: boolean;
  counts_machine_time: boolean;
  is_productive: boolean;
  requires_reason: boolean;
  criticality: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
  signals_planning: boolean;
  signals_maintenance: boolean;
  signals_quality: boolean;
  legacy_time_type: "OPERATEUR" | "MACHINE" | "PROGRAMMATION" | null;
  legacy_of_time_log_type: "SETUP" | "PRODUCTION" | "PROGRAMMING" | "CONTROL" | "MAINTENANCE" | null;
  required_capability: string | null;
  disabled_at: string | null;
};

/**
 * Mapping des types du moteur historique `of_time_logs` vers le référentiel
 * canonique. Ces cinq valeurs sont les seules jamais écrites par les routes
 * time-logs ; l'adaptateur ne peut donc pas rencontrer d'inconnue.
 */
export const LEGACY_TIME_LOG_TO_ACTIVITY: Readonly<Record<string, string>> = {
  SETUP: "SETUP",
  PRODUCTION: "PRODUCTION",
  PROGRAMMING: "PROGRAMMING",
  CONTROL: "CONTROL",
  MAINTENANCE: "MAINTENANCE",
};

/**
 * Chemin inverse : quelle valeur écrire dans `of_time_logs.type` pour qu'un
 * consommateur legacy continue de lire quelque chose de sensé. Les catégories
 * sans équivalent (attentes, arrêts, nettoyage) retombent volontairement sur
 * PRODUCTION uniquement si elles comptent du temps ; sinon la ligne legacy
 * n'est pas écrite du tout, car un arrêt planifié n'est pas du temps de travail.
 */
export function activityToLegacyTimeLogType(category: ActivityCategory | null): string | null {
  if (!category) return "PRODUCTION";
  if (category.legacy_of_time_log_type) return category.legacy_of_time_log_type;
  if (!category.counts_operator_time) return null;
  return "PRODUCTION";
}

export function assertActivityUsable(
  category: ActivityCategory | undefined,
  code: string
): asserts category is ActivityCategory {
  if (!category) {
    throw new HttpError(
      422,
      "PRODUCTION_ACTIVITY_UNKNOWN",
      `Catégorie d'activité inconnue : '${code}'.`
    );
  }
  if (category.disabled_at) {
    throw new HttpError(
      422,
      "PRODUCTION_ACTIVITY_DISABLED",
      `La catégorie d'activité '${code}' est désactivée.`
    );
  }
}

export function assertReasonProvided(category: ActivityCategory, reason: string | null | undefined): void {
  if (!category.requires_reason) return;
  if (typeof reason === "string" && reason.trim().length >= 3) return;
  throw new HttpError(
    422,
    "PRODUCTION_ACTIVITY_REASON_REQUIRED",
    `La catégorie '${category.code}' exige un motif d'au moins 3 caractères.`,
    { details: { fields: { comment: ["Un motif est obligatoire pour cette activité."] } } }
  );
}

/* -------------------------------------------------------------------------- */
/* 5) Temps — conventions de calcul                                           */
/* -------------------------------------------------------------------------- */

/**
 * Convention d'intervalle documentée : `[début, fin)`. Deux segments qui se
 * touchent bout à bout (fin de l'un = début du suivant) ne se chevauchent pas
 * et ne comptent donc jamais la même minute deux fois lors d'un changement
 * d'activité, de machine ou d'opérateur.
 */
export const INTERVAL_CONVENTION = "[start, end)" as const;

export function computeDurationMinutes(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new HttpError(422, "PRODUCTION_EXECUTION_INVALID_INTERVAL", "Horodatages invalides.");
  }
  if (end < start) {
    throw new HttpError(
      422,
      "PRODUCTION_EXECUTION_NEGATIVE_DURATION",
      "La fin d'un pointage ne peut pas précéder son début."
    );
  }
  return Math.max(0, Math.round((end - start) / 60000));
}

/** Garde-fou contre les sessions oubliées et les saisies aberrantes. */
export const MAX_SEGMENT_MINUTES = 24 * 60;

/** Au-delà, une session en cours est signalée comme anormalement longue. */
export const LONG_RUNNING_ALERT_MINUTES = 12 * 60;

export function assertPlausibleDuration(minutes: number): void {
  if (minutes > MAX_SEGMENT_MINUTES) {
    throw new HttpError(
      422,
      "PRODUCTION_EXECUTION_DURATION_TOO_LONG",
      `Un segment ne peut pas dépasser ${MAX_SEGMENT_MINUTES} minutes. Découpez la déclaration.`,
      { minutes }
    );
  }
}

/** Politique de saisie rétroactive : bornée, motivée, auditée, à valider. */
export const RETROACTIVE_WINDOW_DAYS = 7;

export function assertRetroactiveAllowed(startIso: string, nowIso: string): void {
  const start = Date.parse(startIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return;
  const days = (now - start) / 86_400_000;
  if (days > RETROACTIVE_WINDOW_DAYS) {
    throw new HttpError(
      422,
      "PRODUCTION_EXECUTION_RETROACTIVE_WINDOW",
      `La saisie rétroactive est limitée à ${RETROACTIVE_WINDOW_DAYS} jours. Passez par une correction validée.`
    );
  }
  if (start > now + 60_000) {
    throw new HttpError(
      422,
      "PRODUCTION_EXECUTION_FUTURE_START",
      "Un pointage ne peut pas démarrer dans le futur."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 6) Quantités — deltas et bornes                                            */
/* -------------------------------------------------------------------------- */

export type QuantityDelta = {
  qty_good: number;
  qty_scrap: number;
  qty_rework: number;
  qty_pending_control: number;
};

export function assertFiniteQuantities(
  delta: QuantityDelta,
  options: { allowEmpty?: boolean } = {},
): void {
  for (const [key, value] of Object.entries(delta)) {
    if (!Number.isFinite(value)) {
      throw new HttpError(422, "PRODUCTION_QUANTITY_NOT_FINITE", `Quantité invalide : ${key}.`);
    }
    if (value < 0) {
      throw new HttpError(
        422,
        "PRODUCTION_QUANTITY_NEGATIVE",
        `Une déclaration ne porte que des quantités positives : ${key}. Utilisez une compensation motivée.`
      );
    }
  }
  const total = delta.qty_good + delta.qty_scrap + delta.qty_rework + delta.qty_pending_control;
  if (total <= 0 && !options.allowEmpty) {
    throw new HttpError(
      422,
      "PRODUCTION_QUANTITY_EMPTY",
      "Une déclaration de quantité vide n'a pas d'effet : saisissez au moins une valeur."
    );
  }
}

/**
 * Surproduction : interdite par défaut. L'autoriser exige à la fois une
 * tolérance déclarée et un motif — jamais l'un sans l'autre, sinon le
 * dépassement devient silencieux.
 */
export function assertWithinRemaining(params: {
  declared: number;
  alreadyDeclared: number;
  quantityTarget: number;
  overproductionTolerance: number;
  reason: string | null | undefined;
}): void {
  const remaining = params.quantityTarget - params.alreadyDeclared;
  if (params.declared <= remaining) return;

  const ceiling = remaining + params.overproductionTolerance;
  if (params.declared > ceiling) {
    throw new HttpError(
      422,
      "PRODUCTION_QUANTITY_EXCEEDS_REMAINING",
      `Quantité déclarée (${params.declared}) supérieure au restant (${remaining}) augmenté de la tolérance (${params.overproductionTolerance}).`,
      {
        details: {
          fields: { qty_good: [`Le restant est de ${remaining}.`] },
        },
        remaining,
        tolerance: params.overproductionTolerance,
      }
    );
  }
  if (!params.reason || params.reason.trim().length < 3) {
    throw new HttpError(
      422,
      "PRODUCTION_OVERPRODUCTION_REASON_REQUIRED",
      "La surproduction tolérée doit être motivée.",
      { details: { fields: { note: ["Motivez le dépassement du restant."] } } }
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 7) Idempotence                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Empreinte SHA-256 de la charge utile. On stocke l'empreinte et jamais la
 * charge utile elle-même : aucune donnée personnelle n'est recopiée dans la
 * table d'idempotence.
 */
export function fingerprintPayload(scope: string, payload: unknown): string {
  return crypto
    .createHash("sha256")
    .update(`${scope} ${stableStringify(payload)}`)
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function assertIdempotencyMatch(params: {
  key: string;
  storedFingerprint: string;
  incomingFingerprint: string;
}): void {
  if (params.storedFingerprint === params.incomingFingerprint) return;
  throw new HttpError(
    409,
    "PRODUCTION_EXECUTION_IDEMPOTENCY_CONFLICT",
    "Cette clé d'idempotence a déjà été utilisée avec une charge utile différente.",
    { idempotency_key: params.key }
  );
}

/* -------------------------------------------------------------------------- */
/* 8) Frontières inter-modules — ce que le pointage n'a PAS le droit de faire */
/* -------------------------------------------------------------------------- */

/**
 * Le suivi de production déclare ce qui a été fabriqué. Il ne décide jamais
 * seul qu'une quantité est stockable : la chaîne autoritaire reste
 * déclaration → décision qualité si requise → réception de production (#223)
 * → lot → mouvement de stock.
 *
 * Cette constante est documentaire et testée : elle rend explicite, dans le
 * code, ce qu'aucune évolution du module ne doit franchir.
 */
export const FORBIDDEN_SIDE_EFFECTS = [
  "stock_movement",
  "lot_creation",
  "stock_reservation",
  "delivery_note",
  "invoice",
  "hr_attendance",
  "payroll",
] as const;

export type ForbiddenSideEffect = (typeof FORBIDDEN_SIDE_EFFECTS)[number];
