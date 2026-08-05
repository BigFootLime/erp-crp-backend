// Gouvernance du poste opérateur tablette (#159 / crp-systems-web#289) —
// politiques pures, sans I/O : capacités RBAC, cycle de vie d'un appareil et
// d'une session, pseudonymisation des supports d'identification, préparation
// d'une opération et frontières inter-modules.
//
// Ce fichier n'ouvre aucune connexion, n'appelle aucun service et ne lit aucun
// en-tête HTTP : chaque règle est testable seule et rejouée par le service à
// chaque requête.
//
// TROIS CONCEPTS DISTINCTS, JAMAIS CONFONDUS
// ------------------------------------------
//   1. La SESSION DE POSTE (ici)          : « qui est devant cette tablette ? »
//   2. Le SEGMENT D'EXÉCUTION (#274)      : « qui produit quoi, sur quelle
//                                             machine, depuis quand ? »
//   3. Le TEMPS DE PRÉSENCE RH (#119)     : « le salarié était-il là ? »
//
// Ouvrir, verrouiller ou fermer une session ne crée, ne modifie et ne clôt
// jamais un segment d'exécution ni une donnée RH. C'est la règle qui justifie
// l'existence séparée de ce module, et elle est testée.

import crypto from "node:crypto";

import { HttpError } from "../../../utils/httpError";

/* -------------------------------------------------------------------------- */
/* 1) Capacités RBAC — refus par défaut                                       */
/* -------------------------------------------------------------------------- */

export const STATION_CAPABILITIES = [
  /** Voir son propre poste : file de travail, dossier, exécution en cours. */
  "read_own_station",
  /** Ouvrir une session de poste sur une tablette. */
  "open_session",
  /** Choisir ou changer la machine confirmée d'une session mobile. */
  "select_machine",
  /** Consulter le dossier OF numérique (plan, gamme, matière, contrôles). */
  "read_dossier",
  /** Émettre une transmission de poste. */
  "handover_shift",
  /** Accuser réception d'une transmission qui m'est destinée. */
  "acknowledge_handover",
  /** Voir les postes des autres opérateurs (chef d'atelier, méthodes). */
  "supervise_stations",
  /** Enrôler, modifier, désactiver et révoquer une tablette. */
  "administer_devices",
  /** Émettre ou révoquer un support d'identification atelier. */
  "administer_credentials",
  /** Lire le journal d'audit de poste. */
  "audit_stations",
  /** Voir les coûts et taux horaires dans le dossier. Jamais implicite. */
  "view_costs",
] as const;

export type StationCapability = (typeof STATION_CAPABILITIES)[number];

// Les rôles CERP sont du texte libre en base. On garde la mécanique par
// « needles » déjà employée par `production-execution.ts`, `of-rbac.ts` et
// `quality-policy.ts` plutôt que d'inventer une table de rôles parallèle qui
// dériverait aussitôt.
const OPERATOR_NEEDLES = [
  "operateur",
  "opérateur",
  "usineur",
  "regleur",
  "régleur",
  "atelier",
  "production",
] as const;

const SUPERVISOR_NEEDLES = ["admin", "administrateur", "directeur", "chef", "method"] as const;

const CAPABILITY_NEEDLES: Record<StationCapability, readonly string[]> = {
  // Le geste de base : sans lui, un opérateur ne verrait même pas son poste.
  read_own_station: [...OPERATOR_NEEDLES, ...SUPERVISOR_NEEDLES, "qualit", "quality", "qse", "planif"],
  open_session: [...OPERATOR_NEEDLES, ...SUPERVISOR_NEEDLES],
  select_machine: [...OPERATOR_NEEDLES, ...SUPERVISOR_NEEDLES],
  read_dossier: [...OPERATOR_NEEDLES, ...SUPERVISOR_NEEDLES, "qualit", "quality", "qse", "method"],
  handover_shift: [...OPERATOR_NEEDLES, ...SUPERVISOR_NEEDLES],
  acknowledge_handover: [...OPERATOR_NEEDLES, ...SUPERVISOR_NEEDLES],
  // Voir le poste d'un tiers est une capacité distincte : un opérateur n'a pas
  // à savoir ce que fait son voisin.
  supervise_stations: [...SUPERVISOR_NEEDLES, "planif", "qualit", "quality", "qse"],
  administer_devices: ["admin", "administrateur", "directeur", "method"],
  administer_credentials: ["admin", "administrateur", "directeur"],
  audit_stations: ["admin", "administrateur", "directeur", "qualit", "quality", "qse"],
  // Voir du temps n'est pas voir de l'argent : périmètre volontairement fermé.
  view_costs: ["admin", "administrateur", "directeur", "compta", "controle", "contrôle"],
};

/**
 * Aucune capacité de ce module ne doit toucher au domaine RH. La liste est
 * vérifiée par test : elle empêche qu'une capacité `attendance` ou `payroll`
 * apparaisse ici au fil des refactorisations.
 */
export const FORBIDDEN_STATION_CAPABILITY_FRAGMENTS = [
  "attendance",
  "presence",
  "présence",
  "payroll",
  "paie",
  "overtime",
  "geoloc",
  "biometric",
  "biometrie",
  "biométrie",
  "salary",
  "salaire",
] as const;

export function roleHasStationCapability(
  role: string | null | undefined,
  capability: StationCapability
): boolean {
  if (hasGrantedAccountModuleAccess()) return true;
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return false;
  const needles = CAPABILITY_NEEDLES[capability];
  if (!needles) return false;
  return needles.some((needle) => normalized.includes(needle));
}

export function listStationCapabilities(role: string | null | undefined): StationCapability[] {
  return STATION_CAPABILITIES.filter((capability) => roleHasStationCapability(role, capability));
}

export function assertStationCapability(
  role: string | null | undefined,
  capability: StationCapability
): void {
  if (!roleHasStationCapability(role, capability)) {
    throw new HttpError(
      403,
      "STATION_CAPABILITY_REQUIRED",
      `La capacité de poste '${capability}' est requise.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 2) Frontières inter-modules — déclarées dans le code, pas seulement en doc  */
/* -------------------------------------------------------------------------- */

/**
 * Ce que le poste opérateur ne fera JAMAIS, quelle que soit l'action demandée.
 * La liste est parcourue par un test qui inspecte les requêtes SQL du module :
 * une régression qui ajouterait un `INSERT INTO stock_movements` échoue.
 */
export const FORBIDDEN_STATION_SIDE_EFFECTS = [
  "hr_time_events",
  "hr_time_entries",
  "hr_badge_credentials",
  "hr_time_clock_devices",
  "payroll",
  "stock_movements",
  "stock_movement_lines",
  "stock_reservations",
  "lots",
  "of_output_lots",
  "production_receipts",
  "bons_livraison",
  "bon_livraison_lignes",
  "factures",
  "facture_lignes",
  "avoirs",
] as const;

/**
 * Le poste peut PROPOSER la prochaine action métier, jamais l'exécuter. Chaque
 * proposition nomme le service autoritaire qui, seul, a le droit d'agir.
 */
export type NextBusinessAction = {
  code: "QUALITY_DECISION" | "PRODUCTION_RECEIPT" | "NEXT_OPERATION" | "NONE";
  label: string;
  owning_module: string;
  /** Le poste ne déclenche rien : il indique où aller. */
  actionable_here: false;
};

/* -------------------------------------------------------------------------- */
/* 3) Cycle de vie d'un appareil                                              */
/* -------------------------------------------------------------------------- */

export const DEVICE_STATUSES = ["ACTIVE", "DISABLED", "REVOKED"] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const DEVICE_ASSIGNMENT_MODES = ["FIXED", "MOBILE"] as const;
export type DeviceAssignmentMode = (typeof DEVICE_ASSIGNMENT_MODES)[number];

// Une révocation est définitive : une tablette volée ne « redevient » pas
// active parce qu'on l'a retrouvée. On en enrôle une nouvelle.
const DEVICE_TRANSITIONS: Readonly<Record<DeviceStatus, readonly DeviceStatus[]>> = {
  ACTIVE: ["DISABLED", "REVOKED"],
  DISABLED: ["ACTIVE", "REVOKED"],
  REVOKED: [],
};

export function assertDeviceTransition(from: DeviceStatus, to: DeviceStatus): void {
  if (from === to) return;
  if (!DEVICE_TRANSITIONS[from]?.includes(to)) {
    throw new HttpError(
      409,
      "STATION_DEVICE_TRANSITION_FORBIDDEN",
      `Transition d'appareil interdite : ${from} vers ${to}.`
    );
  }
}

export type DeviceState = {
  id: string;
  public_code: string;
  status: DeviceStatus;
  assignment_mode: DeviceAssignmentMode;
  machine_id: string | null;
  auto_lock_seconds: number;
  session_max_seconds: number;
};

/**
 * Un appareil doit être exploitable AVANT toute autre vérification : inutile de
 * discuter des droits d'un opérateur sur une tablette révoquée. Les codes
 * d'erreur sont distincts pour que l'écran affiche la bonne consigne
 * (« contactez le chef d'atelier » ≠ « tablette inconnue »).
 */
export function assertDeviceUsable(device: DeviceState | null): asserts device is DeviceState {
  if (!device) {
    throw new HttpError(
      404,
      "STATION_DEVICE_UNKNOWN",
      "Cette tablette n'est pas enregistrée dans CERP."
    );
  }
  if (device.status === "REVOKED") {
    throw new HttpError(
      403,
      "STATION_DEVICE_REVOKED",
      "Cette tablette a été révoquée. Elle ne peut plus ouvrir de session."
    );
  }
  if (device.status === "DISABLED") {
    throw new HttpError(
      403,
      "STATION_DEVICE_DISABLED",
      "Cette tablette est désactivée. Contactez le chef d'atelier."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 4) Cycle de vie d'une session de poste                                     */
/* -------------------------------------------------------------------------- */

export const SESSION_STATES = ["ACTIVE", "LOCKED", "CLOSED", "EXPIRED", "REVOKED"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

const SESSION_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  ACTIVE: ["LOCKED", "CLOSED", "EXPIRED", "REVOKED"],
  // Un écran verrouillé se déverrouille, se ferme, expire ou est révoqué.
  LOCKED: ["ACTIVE", "CLOSED", "EXPIRED", "REVOKED"],
  CLOSED: [],
  EXPIRED: [],
  REVOKED: [],
};

export function assertSessionTransition(from: SessionState, to: SessionState): void {
  if (!SESSION_TRANSITIONS[from]?.includes(to)) {
    throw new HttpError(
      409,
      "STATION_SESSION_TRANSITION_FORBIDDEN",
      `Transition de session interdite : ${from} vers ${to}.`
    );
  }
}

export type SessionState_ = {
  id: string;
  device_id: string;
  user_id: number;
  machine_id: string | null;
  state: SessionState;
  expires_at: Date;
  last_activity_at: Date;
};

export type SessionEvaluation =
  | { usable: true; reason: null }
  | { usable: false; reason: "EXPIRED" | "IDLE_LOCK" | "LOCKED" | "CLOSED" };

/**
 * Décide si une session est encore utilisable, SANS la modifier. Le service
 * traduit ensuite la décision en transition persistée.
 *
 * Le verrouillage par inactivité est calculé côté serveur : une tablette dont
 * l'horloge locale a dérivé — ou a été reculée volontairement — ne prolonge pas
 * sa session.
 */
export function evaluateSession(params: {
  session: Pick<SessionState_, "state" | "expires_at" | "last_activity_at">;
  autoLockSeconds: number;
  now: Date;
}): SessionEvaluation {
  const { session, autoLockSeconds, now } = params;

  if (session.state === "CLOSED" || session.state === "EXPIRED" || session.state === "REVOKED") {
    return { usable: false, reason: "CLOSED" };
  }
  if (session.expires_at.getTime() <= now.getTime()) {
    return { usable: false, reason: "EXPIRED" };
  }
  if (session.state === "LOCKED") {
    return { usable: false, reason: "LOCKED" };
  }
  const idleMs = now.getTime() - session.last_activity_at.getTime();
  if (idleMs >= autoLockSeconds * 1000) {
    return { usable: false, reason: "IDLE_LOCK" };
  }
  return { usable: true, reason: null };
}

/**
 * Verrouiller un écran n'arrête RIEN. C'est la règle la plus importante du
 * module : un opérateur qui pose sa tablette pour changer un outil ne doit pas
 * voir son pointage s'arrêter tout seul, et un pointage qui continue ne doit pas
 * empêcher l'écran de se verrouiller.
 */
export const LOCK_NEVER_STOPS_EXECUTION = true as const;

/**
 * Changer d'opérateur alors qu'un segment tourne exige une décision métier
 * explicite. Le silence n'est pas une option : soit on transmet, soit on met en
 * pause, soit un superviseur tranche.
 */
export type OperatorSwitchDecision = "HANDOVER" | "PAUSE" | "SUPERVISOR_OVERRIDE";

export function assertOperatorSwitchDecided(params: {
  hasActiveExecution: boolean;
  decision: OperatorSwitchDecision | null | undefined;
  actorRole: string | null | undefined;
}): void {
  if (!params.hasActiveExecution) return;

  if (!params.decision) {
    throw new HttpError(
      409,
      "STATION_ACTIVE_EXECUTION_REQUIRES_DECISION",
      "Un pointage est en cours sur ce poste. Choisissez : transmettre le poste, mettre en pause, ou appeler un superviseur."
    );
  }
  if (
    params.decision === "SUPERVISOR_OVERRIDE" &&
    !roleHasStationCapability(params.actorRole, "supervise_stations")
  ) {
    throw new HttpError(
      403,
      "STATION_SUPERVISOR_REQUIRED",
      "Seul un superviseur peut reprendre un poste occupé sans transmission."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 5) Identification — pseudonymisation et anti-rejeu                          */
/* -------------------------------------------------------------------------- */

export const IDENTIFICATION_METHODS = ["BADGE", "QR", "PASSWORD", "SSO"] as const;
export type IdentificationMethod = (typeof IDENTIFICATION_METHODS)[number];

/**
 * Empreinte d'un support d'identification.
 *
 * HMAC-SHA-256 avec un poivre serveur : un simple SHA-256 d'un UID de badge est
 * cassable par force brute en quelques secondes (l'espace des UID est minuscule).
 * Sans le poivre, une copie de la base ne permet donc pas de retrouver les
 * numéros gravés sur les cartes.
 *
 * Le poivre n'est jamais journalisé, jamais renvoyé, jamais stocké en base.
 */
export function fingerprintCredential(rawCredential: string, pepper: string): string {
  const value = rawCredential.trim();
  if (!value) {
    throw new HttpError(400, "STATION_CREDENTIAL_EMPTY", "Support d'identification vide.");
  }
  if (!pepper || pepper.length < 16) {
    // Refus explicite plutôt que dégradation silencieuse vers un hachage faible.
    throw new HttpError(
      500,
      "STATION_BADGE_PEPPER_MISSING",
      "L'identification par badge n'est pas configurée sur ce serveur."
    );
  }
  return crypto.createHmac("sha256", pepper).update(value, "utf8").digest("hex");
}

/** Jeton de session opaque. Ce n'est PAS un JWT : il est révocable côté serveur. */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Seule l'empreinte du jeton est stockée : une fuite de base ne donne aucune session. */
export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Comparaison à temps constant. Une comparaison naïve laisse fuir, par le
 * temps de réponse, le nombre de caractères corrects.
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export const BADGE_MAX_FAILED_ATTEMPTS = 5;
export const BADGE_LOCK_SECONDS = 300;

export function assertCredentialNotLocked(params: {
  locked_until: Date | null;
  now: Date;
}): void {
  if (params.locked_until && params.locked_until.getTime() > params.now.getTime()) {
    const seconds = Math.ceil((params.locked_until.getTime() - params.now.getTime()) / 1000);
    throw new HttpError(
      429,
      "STATION_CREDENTIAL_LOCKED",
      `Trop de tentatives. Réessayez dans ${seconds} seconde(s) ou identifiez-vous autrement.`
    );
  }
}

/**
 * Anti-rejeu du QR : un code présenté deux fois est refusé. La fenêtre est
 * courte parce qu'un QR affiché sur un écran est photographiable.
 */
export const QR_NONCE_WINDOW_SECONDS = 60;

export function assertNonceFresh(params: { issuedAt: Date; now: Date; seenBefore: boolean }): void {
  if (params.seenBefore) {
    throw new HttpError(
      409,
      "STATION_CREDENTIAL_REPLAYED",
      "Ce code a déjà été utilisé. Présentez un code neuf."
    );
  }
  const ageSeconds = (params.now.getTime() - params.issuedAt.getTime()) / 1000;
  if (ageSeconds < -5 || ageSeconds > QR_NONCE_WINDOW_SECONDS) {
    throw new HttpError(
      409,
      "STATION_CREDENTIAL_EXPIRED",
      "Ce code n'est plus valide. Présentez un code neuf."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 6) Confirmation de machine                                                 */
/* -------------------------------------------------------------------------- */

export type MachineCandidate = {
  id: string;
  code: string;
  name: string;
  status: string;
  is_available: boolean;
  workshop_zone: string | null;
  archived_at: Date | null;
  /** Occupation dérivée du moteur #274, jamais recalculée ici. */
  active_operator_user_id: number | null;
  active_of_numero: string | null;
};

export type MachineSelectability = {
  machine_id: string;
  selectable: boolean;
  /** Raison LISIBLE : l'opérateur doit comprendre sans appeler personne. */
  reason: string;
  reason_code:
    | "OK"
    | "MACHINE_ARCHIVED"
    | "MACHINE_INACTIVE"
    | "MACHINE_UNAVAILABLE"
    | "MACHINE_BUSY"
    | "MACHINE_OUT_OF_ZONE";
  /** Occupée par quelqu'un d'autre : on l'affiche, on ne la force pas. */
  busy_by_other: boolean;
};

export function evaluateMachineSelectability(params: {
  machine: MachineCandidate;
  actorUserId: number;
  deviceZone: string | null;
  enforceZone: boolean;
}): MachineSelectability {
  const { machine, actorUserId, deviceZone, enforceZone } = params;
  const base = { machine_id: machine.id, busy_by_other: false };

  if (machine.archived_at) {
    return { ...base, selectable: false, reason_code: "MACHINE_ARCHIVED", reason: "Machine archivée." };
  }
  if ((machine.status ?? "").toUpperCase() !== "ACTIVE") {
    return {
      ...base,
      selectable: false,
      reason_code: "MACHINE_INACTIVE",
      reason: `Machine ${String(machine.status ?? "").toLowerCase() || "inactive"} : indisponible à la production.`,
    };
  }
  if (!machine.is_available) {
    return {
      ...base,
      selectable: false,
      reason_code: "MACHINE_UNAVAILABLE",
      reason: "Machine signalée indisponible (maintenance ou blocage qualité).",
    };
  }
  if (enforceZone && deviceZone && machine.workshop_zone && machine.workshop_zone !== deviceZone) {
    return {
      ...base,
      selectable: false,
      reason_code: "MACHINE_OUT_OF_ZONE",
      reason: `Machine hors de la zone ${deviceZone}.`,
    };
  }
  if (machine.active_operator_user_id !== null && machine.active_operator_user_id !== actorUserId) {
    // On n'invente pas de « prise de force » : l'écran propose de consulter,
    // d'appeler un superviseur ou de choisir une autre machine.
    return {
      machine_id: machine.id,
      selectable: false,
      busy_by_other: true,
      reason_code: "MACHINE_BUSY",
      reason: machine.active_of_numero
        ? `Machine occupée par un autre opérateur (OF ${machine.active_of_numero}).`
        : "Machine occupée par un autre opérateur.",
    };
  }
  return { ...base, selectable: true, reason_code: "OK", reason: "Machine disponible." };
}

/* -------------------------------------------------------------------------- */
/* 7) Préparation d'une opération — recommandation EXPLIQUÉE                  */
/* -------------------------------------------------------------------------- */

export const READINESS_LEVELS = ["READY", "INCOMPLETE", "AWAITING_CONTROL", "BLOCKED"] as const;
export type ReadinessLevel = (typeof READINESS_LEVELS)[number];

export type WorklistSignals = {
  of_statut: string;
  operation_status: string;
  has_pending_predecessor: boolean;
  has_active_execution_by_other: boolean;
  machine_matches: boolean;
  machine_available: boolean;
  /** Le snapshot technique figé au lancement de l'OF est-il présent ? */
  has_technical_snapshot: boolean;
  /** Un plan (document) est-il rattaché à la pièce ? */
  has_plan_document: boolean;
  /** Un premier article est-il exigé ET non encore prononcé conforme ? */
  first_article_pending: boolean;
  /** Quantité déclarée en attente d'une décision Qualité. */
  qty_pending_control: number;
  remaining_quantity: number;
};

export type ReadinessAssessment = {
  level: ReadinessLevel;
  /** Raisons ordonnées de la plus bloquante à la plus informative. */
  reasons: Array<{ code: string; label: string; severity: "BLOCKING" | "WARNING" | "INFO" }>;
  /** Phrase unique affichée sur la carte. Jamais un score opaque. */
  headline: string;
};

const OF_BLOCKING_STATUSES = new Set(["ANNULE", "ANNULÉ", "TERMINE", "TERMINÉ", "SUSPENDU", "BROUILLON"]);

/**
 * Explique pourquoi une opération est proposée — ou ne l'est pas.
 *
 * Le classement n'est PAS un score : c'est une liste de faits vérifiables. Un
 * atelier ne fait pas confiance à un chiffre qu'il ne peut pas contredire, et
 * CERP n'a pas les données pour prétendre à une priorisation « intelligente ».
 */
export function assessOperationReadiness(signals: WorklistSignals): ReadinessAssessment {
  const reasons: ReadinessAssessment["reasons"] = [];

  const statut = (signals.of_statut ?? "").toUpperCase();
  if (OF_BLOCKING_STATUSES.has(statut)) {
    reasons.push({
      code: "OF_NOT_LAUNCHED",
      label: `Ordre de fabrication en statut ${statut.toLowerCase()} : non pointable.`,
      severity: "BLOCKING",
    });
  }

  const opStatus = (signals.operation_status ?? "").toUpperCase();
  if (opStatus === "DONE" || opStatus === "CANCELLED") {
    reasons.push({
      code: "OPERATION_CLOSED",
      label: "Opération déjà clôturée.",
      severity: "BLOCKING",
    });
  }

  if (signals.has_active_execution_by_other) {
    reasons.push({
      code: "ALREADY_RUNNING",
      label: "Un autre opérateur pointe déjà cette opération.",
      severity: "BLOCKING",
    });
  }

  if (!signals.machine_available) {
    reasons.push({
      code: "MACHINE_UNAVAILABLE",
      label: "La machine attendue est indisponible.",
      severity: "BLOCKING",
    });
  }

  if (!signals.has_technical_snapshot) {
    // Sans snapshot, on ne sait PAS quel indice a été lancé. Travailler « sur la
    // dernière version » serait exactement l'erreur que ce module doit empêcher.
    reasons.push({
      code: "NO_TECHNICAL_SNAPSHOT",
      label: "Aucun snapshot technique figé : l'indice lancé n'est pas certain.",
      severity: "BLOCKING",
    });
  }

  if (signals.first_article_pending) {
    reasons.push({
      code: "FIRST_ARTICLE_REQUIRED",
      label: "Premier article exigé par le plan de contrôle : série interdite avant décision Qualité.",
      severity: "BLOCKING",
    });
  }

  if (signals.has_pending_predecessor) {
    reasons.push({
      code: "PREDECESSOR_PENDING",
      label: "Une phase précédente n'est pas terminée.",
      severity: "WARNING",
    });
  }

  if (!signals.has_plan_document) {
    reasons.push({
      code: "NO_PLAN_DOCUMENT",
      label: "Aucun plan rattaché à la pièce.",
      severity: "WARNING",
    });
  }

  if (!signals.machine_matches) {
    reasons.push({
      code: "MACHINE_MISMATCH",
      label: "Cette opération est prévue sur une autre machine.",
      severity: "WARNING",
    });
  }

  if (signals.qty_pending_control > 0) {
    reasons.push({
      code: "QTY_AWAITING_CONTROL",
      label: `${signals.qty_pending_control} pièce(s) en attente de décision Qualité.`,
      severity: "INFO",
    });
  }

  if (signals.remaining_quantity <= 0) {
    reasons.push({
      code: "NOTHING_REMAINING",
      label: "Quantité lancée déjà couverte par les déclarations.",
      severity: "WARNING",
    });
  }

  const hasBlocking = reasons.some((r) => r.severity === "BLOCKING");
  const hasWarning = reasons.some((r) => r.severity === "WARNING");

  let level: ReadinessLevel;
  if (hasBlocking) {
    level = signals.first_article_pending && reasons.every((r) => r.code === "FIRST_ARTICLE_REQUIRED")
      ? "AWAITING_CONTROL"
      : "BLOCKED";
  } else if (hasWarning) {
    level = "INCOMPLETE";
  } else {
    level = "READY";
  }

  const headline =
    reasons.find((r) => r.severity === "BLOCKING")?.label ??
    reasons.find((r) => r.severity === "WARNING")?.label ??
    "Prêt à démarrer : matière, plan et machine disponibles.";

  return { level, reasons, headline };
}

/**
 * Ordre d'affichage de la file. Trois critères vérifiables, dans cet ordre :
 * préparation, date cible, phase. Aucun poids arbitraire, aucun apprentissage,
 * aucun « score de pertinence » que personne ne pourrait auditer.
 */
export const WORKLIST_ORDERING_EXPLANATION =
  "Trié par : opérations prêtes d'abord, puis date de fin prévue la plus proche, puis numéro de phase.";

const READINESS_RANK: Record<ReadinessLevel, number> = {
  READY: 0,
  INCOMPLETE: 1,
  AWAITING_CONTROL: 2,
  BLOCKED: 3,
};

export function compareWorklistEntries(
  a: { readiness: ReadinessLevel; due_date: string | null; phase: number },
  b: { readiness: ReadinessLevel; due_date: string | null; phase: number }
): number {
  const byReadiness = READINESS_RANK[a.readiness] - READINESS_RANK[b.readiness];
  if (byReadiness !== 0) return byReadiness;

  // Une opération sans date cible passe APRÈS celles qui en ont une : elle
  // n'est pas urgente, elle est simplement non planifiée.
  const aDue = a.due_date ? Date.parse(a.due_date) : Number.POSITIVE_INFINITY;
  const bDue = b.due_date ? Date.parse(b.due_date) : Number.POSITIVE_INFINITY;
  if (aDue !== bDue) return aDue - bDue;

  return a.phase - b.phase;
}

/* -------------------------------------------------------------------------- */
/* 8) Dossier opérateur — ce qui est montré, et ce qui ne l'est jamais        */
/* -------------------------------------------------------------------------- */

/**
 * Champs qu'aucune réponse du module ne doit contenir. `storage_path` en tête :
 * exposer un chemin disque donne à un opérateur une carte du serveur de
 * fichiers, et cette fuite a déjà été corrigée deux fois ailleurs dans CERP.
 */
export const NEVER_EXPOSED_FIELDS = [
  "storage_path",
  "stored_name",
  "password",
  "session_token_hash",
  "credential_hash",
  "enrollment_secret_hash",
  "badge_uid",
  "badge_uid_hash",
] as const;

/** Champs de coût, masqués sans la capacité `view_costs`. */
export const COST_FIELDS = [
  "hourly_rate",
  "hourly_rate_applied",
  "cout_mo",
  "taux_horaire",
  "prix",
  "prix_unitaire",
  "marge",
] as const;

export function stripCostFields<T extends Record<string, unknown>>(
  row: T,
  canViewCosts: boolean
): T {
  if (canViewCosts) return row;
  const copy: Record<string, unknown> = { ...row };
  for (const field of COST_FIELDS) {
    if (field in copy) delete copy[field];
  }
  return copy as T;
}

/* -------------------------------------------------------------------------- */
/* 9) Snapshot technique — la règle de l'indice                               */
/* -------------------------------------------------------------------------- */

export type TechnicalSnapshotRef = {
  piece_technique_version_id: string | null;
  snapshot_sha256: string | null;
  snapshot_at: Date | null;
};

export type PlanDocumentRef = {
  id: string;
  label: string | null;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string | null;
  /** Version de pièce à laquelle ce document appartient. */
  piece_technique_id: string;
};

export type PlanResolution = {
  document: PlanDocumentRef | null;
  /** `true` uniquement si le document appartient bien à la version FIGÉE. */
  matches_snapshot: boolean;
  warning: string | null;
};

/**
 * Résout le plan à afficher.
 *
 * La tentation est de montrer « le dernier plan de la pièce ». C'est
 * précisément l'erreur que l'atelier paie en pièces rebutées : un OF lancé sur
 * l'indice B doit continuer à montrer l'indice B, même si l'indice C existe.
 *
 * Quand aucun document n'est rattaché à la version figée, on ne substitue PAS
 * silencieusement un autre document : on renvoie l'absence et l'avertissement.
 */
export function resolvePlanForSnapshot(params: {
  snapshot: TechnicalSnapshotRef;
  documentsForSnapshotVersion: PlanDocumentRef[];
  latestVersionIndice: string | null;
  snapshotIndice: string | null;
}): PlanResolution {
  const { snapshot, documentsForSnapshotVersion, latestVersionIndice, snapshotIndice } = params;

  if (!snapshot.piece_technique_version_id) {
    return {
      document: null,
      matches_snapshot: false,
      warning:
        "Aucun snapshot technique n'a été figé au lancement de cet OF : le plan applicable ne peut pas être garanti.",
    };
  }

  const document = documentsForSnapshotVersion[0] ?? null;
  if (!document) {
    return {
      document: null,
      matches_snapshot: false,
      warning: `Aucun plan n'est rattaché à l'indice figé${snapshotIndice ? ` ${snapshotIndice}` : ""}. Demandez le dossier aux méthodes.`,
    };
  }

  const supersededWarning =
    latestVersionIndice && snapshotIndice && latestVersionIndice !== snapshotIndice
      ? `Un indice plus récent existe (${latestVersionIndice}). Cet OF reste lancé sur l'indice ${snapshotIndice} : c'est celui-ci qui fait foi.`
      : null;

  return { document, matches_snapshot: true, warning: supersededWarning };
}

/* -------------------------------------------------------------------------- */
/* 10) Transmission de poste                                                  */
/* -------------------------------------------------------------------------- */

export const HANDOVER_MACHINE_STATES = [
  "RUNNING",
  "STOPPED",
  "SETUP",
  "FAULT",
  "MAINTENANCE",
  "UNKNOWN",
] as const;
export type HandoverMachineState = (typeof HANDOVER_MACHINE_STATES)[number];

export function assertHandoverParties(params: {
  outgoingUserId: number;
  incomingUserId: number;
}): void {
  if (params.outgoingUserId === params.incomingUserId) {
    throw new HttpError(
      400,
      "STATION_HANDOVER_SAME_USER",
      "Une transmission de poste suppose deux opérateurs différents."
    );
  }
}

export function assertHandoverAcknowledgeable(params: {
  incomingUserId: number;
  actorUserId: number;
  actorRole: string | null | undefined;
  alreadyAcknowledgedAt: Date | null;
}): void {
  if (params.alreadyAcknowledgedAt) {
    throw new HttpError(
      409,
      "STATION_HANDOVER_ALREADY_ACKNOWLEDGED",
      "Cette transmission a déjà été accusée de réception."
    );
  }
  if (params.actorUserId === params.incomingUserId) return;
  if (roleHasStationCapability(params.actorRole, "supervise_stations")) return;
  throw new HttpError(
    403,
    "STATION_HANDOVER_NOT_ADDRESSEE",
    "Cette transmission est destinée à un autre opérateur."
  );
}

/* -------------------------------------------------------------------------- */
/* 11) Anti-IDOR                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Un opérateur ne pilote que SES sessions. Élargir le périmètre exige une
 * capacité explicite — masquer un bouton côté UI n'a jamais été une
 * autorisation.
 */
export function assertOwnSessionOrSupervision(params: {
  actorUserId: number;
  actorRole: string | null | undefined;
  sessionUserId: number;
  action: string;
}): void {
  if (params.actorUserId === params.sessionUserId) return;
  if (roleHasStationCapability(params.actorRole, "supervise_stations")) return;
  throw new HttpError(
    403,
    "STATION_FOREIGN_SESSION",
    `Cette session appartient à un autre opérateur : '${params.action}' est refusé.`
  );
}

/* -------------------------------------------------------------------------- */
/* 12) Salons temps réel                                                      */
/* -------------------------------------------------------------------------- */

export type StationRoom =
  | { kind: "USER"; userId: number }
  | { kind: "MACHINE"; machineId: string }
  | { kind: "OF"; ofId: number }
  | { kind: "STATION"; deviceId: string };

const ROOM_PATTERNS: Array<{ re: RegExp; build: (m: RegExpExecArray) => StationRoom | null }> = [
  { re: /^USER:(\d+)$/, build: (m) => ({ kind: "USER", userId: Number(m[1]) }) },
  { re: /^MACHINE:([0-9a-fA-F-]{36})$/, build: (m) => ({ kind: "MACHINE", machineId: m[1] }) },
  { re: /^OF:(\d+)$/, build: (m) => ({ kind: "OF", ofId: Number(m[1]) }) },
  { re: /^STATION:([0-9a-fA-F-]{36})$/, build: (m) => ({ kind: "STATION", deviceId: m[1] }) },
];

/**
 * Un nom de salon envoyé par le client n'est jamais accordé tel quel : il est
 * d'abord PARSÉ. Ce qui n'est pas reconnu n'est pas un salon de poste et sera
 * traité par la politique générale du serveur socket.
 */
export function parseStationRoom(room: string): StationRoom | null {
  for (const { re, build } of ROOM_PATTERNS) {
    const m = re.exec(room);
    if (m) return build(m);
  }
  return null;
}

/**
 * Autorisation d'abonnement. `USER:` est strictement personnel ; `MACHINE:`,
 * `OF:` et `STATION:` exigent au minimum de pouvoir lire son poste, et la
 * supervision pour observer sans y être affecté.
 */
export function canSubscribeStationRoom(params: {
  room: StationRoom;
  actorUserId: number;
  actorRole: string | null | undefined;
  /** Machines confirmées par une session vivante de cet utilisateur. */
  ownMachineIds: readonly string[];
  /** OF sur lesquels cet utilisateur a un segment actif. */
  ownOfIds: readonly number[];
  /** Appareils sur lesquels cet utilisateur a une session vivante. */
  ownDeviceIds: readonly string[];
}): boolean {
  const { room, actorUserId, actorRole } = params;

  switch (room.kind) {
    case "USER":
      return room.userId === actorUserId;
    case "MACHINE":
      if (!roleHasStationCapability(actorRole, "read_own_station")) return false;
      if (params.ownMachineIds.includes(room.machineId)) return true;
      return roleHasStationCapability(actorRole, "supervise_stations");
    case "OF":
      if (!roleHasStationCapability(actorRole, "read_own_station")) return false;
      if (params.ownOfIds.includes(room.ofId)) return true;
      return roleHasStationCapability(actorRole, "supervise_stations");
    case "STATION":
      if (params.ownDeviceIds.includes(room.deviceId)) return true;
      return roleHasStationCapability(actorRole, "supervise_stations");
    default:
      return false;
  }
}

/* -------------------------------------------------------------------------- */
/* 13) Événements d'audit                                                     */
/* -------------------------------------------------------------------------- */

export const STATION_AUDIT_EVENTS = [
  "DEVICE_ENROLLED",
  "DEVICE_UPDATED",
  "DEVICE_DISABLED",
  "DEVICE_REVOKED",
  "CREDENTIAL_ISSUED",
  "CREDENTIAL_REVOKED",
  "SESSION_OPENED",
  "SESSION_LOCKED",
  "SESSION_UNLOCKED",
  "SESSION_CLOSED",
  "SESSION_EXPIRED",
  "IDENTIFICATION_FAILED",
  "MACHINE_CONFIRMED",
  "MACHINE_REFUSED",
  "OPERATOR_SWITCHED",
  "HANDOVER_CREATED",
  "HANDOVER_ACKNOWLEDGED",
  "AUTHORIZATION_DENIED",
  "ROOM_SUBSCRIPTION_DENIED",
  "DOSSIER_OPENED",
  "PLAN_OPENED",
  "HEARTBEAT",
  "OFFLINE_EVENT_SYNCED",
  "OFFLINE_EVENT_REJECTED",
] as const;

export type StationAuditEventType = (typeof STATION_AUDIT_EVENTS)[number];

/**
 * Nettoie le contexte d'audit. Un journal qui recopie un UID de badge ou un
 * jeton devient lui-même une cible ; il n'y a donc aucune raison d'y écrire un
 * secret pour « faciliter le débogage ».
 */
export function sanitizeAuditDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    const lower = key.toLowerCase();
    const looksSensitive =
      NEVER_EXPOSED_FIELDS.some((f) => lower.includes(f)) ||
      lower.includes("token") ||
      lower.includes("secret") ||
      lower.includes("password") ||
      lower.includes("badge_uid") ||
      lower.includes("pepper");
    if (looksSensitive) continue;
    if (typeof value === "string" && value.length > 512) {
      out[key] = `${value.slice(0, 512)}…`;
      continue;
    }
    out[key] = value;
  }
  return out;
}
import { hasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
