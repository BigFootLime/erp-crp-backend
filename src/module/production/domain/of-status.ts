// Statuts OF — automate canonique serveur (#170, calqué sur src/module/devis/lib/status.ts).
// La vérité des transitions vit ici : aucun contrôleur/repository ne décide seul d'un statut.
// « Suspendue » d'opération = BLOCKED (modèle réel : l'enum of_operation_status n'a pas d'ANNULE ;
// l'annulation se joue au niveau de l'OF via le statut ANNULE).

export const OF_STATUTS = [
  "BROUILLON",
  "PLANIFIE",
  "EN_COURS",
  "EN_PAUSE",
  "TERMINE",
  "CLOTURE",
  "ANNULE",
] as const;
export type OfStatut = (typeof OF_STATUTS)[number];

export const OF_STATUT_LABELS: Record<OfStatut, string> = {
  BROUILLON: "Brouillon",
  PLANIFIE: "Planifié",
  EN_COURS: "En cours",
  EN_PAUSE: "En pause",
  TERMINE: "Terminé",
  CLOTURE: "Clôturé",
  ANNULE: "Annulé",
};

// TERMINE -> EN_COURS reste ouvert : une reprise atelier après déclaration
// prématurée est une réalité (correction contrôlée, auditée), pas une
// réécriture d'historique. CLOTURE et ANNULE sont terminaux.
export const OF_STATUT_TRANSITIONS: Record<OfStatut, readonly OfStatut[]> = {
  BROUILLON: ["PLANIFIE", "EN_COURS", "ANNULE"],
  PLANIFIE: ["BROUILLON", "EN_COURS", "ANNULE"],
  EN_COURS: ["EN_PAUSE", "TERMINE", "ANNULE"],
  EN_PAUSE: ["EN_COURS", "ANNULE"],
  TERMINE: ["EN_COURS", "CLOTURE"],
  CLOTURE: [],
  ANNULE: [],
};

export function canTransitionOfStatut(from: OfStatut, to: OfStatut): boolean {
  if (from === to) return true;
  return OF_STATUT_TRANSITIONS[from].includes(to);
}

// Un OF « lancé » n'est plus librement éditable : seule la vie d'atelier
// (statut, quantités réalisées, dates réelles, priorité, notes) reste ouverte.
export const OF_PRELAUNCH_STATUTS: readonly OfStatut[] = ["BROUILLON", "PLANIFIE"];

export function isOfPrelaunch(statut: OfStatut): boolean {
  return OF_PRELAUNCH_STATUTS.includes(statut);
}

// Statuts d'OF sur lesquels un pointage/une exécution d'opération est admissible.
// Démarrer une opération sur un OF BROUILLON/PLANIFIE le fait basculer EN_COURS
// (transition automatique serveur, auditée).
export const OF_STATUTS_ALLOWING_EXECUTION: readonly OfStatut[] = [
  "BROUILLON",
  "PLANIFIE",
  "EN_COURS",
  "EN_PAUSE",
];

export function ofStatutAllowsExecution(statut: OfStatut): boolean {
  return OF_STATUTS_ALLOWING_EXECUTION.includes(statut);
}

// Réception de production : uniquement sur un OF vivant ou terminé, jamais
// annulé ni clôturé.
export const OF_STATUTS_ALLOWING_RECEIPT: readonly OfStatut[] = [
  "EN_COURS",
  "EN_PAUSE",
  "TERMINE",
];

export function ofStatutAllowsReceipt(statut: OfStatut): boolean {
  return OF_STATUTS_ALLOWING_RECEIPT.includes(statut);
}

// ---------------------------------------------------------------------------
// Opérations d'OF
// ---------------------------------------------------------------------------

export const OF_OPERATION_STATUSES = ["TODO", "READY", "RUNNING", "DONE", "BLOCKED"] as const;
export type OfOperationStatus = (typeof OF_OPERATION_STATUSES)[number];

// DONE -> READY : réouverture contrôlée (déclaration erronée), auditée.
// RUNNING -> READY : suspension sans blocage qualité.
export const OF_OPERATION_STATUS_TRANSITIONS: Record<OfOperationStatus, readonly OfOperationStatus[]> = {
  TODO: ["READY", "RUNNING", "BLOCKED"],
  READY: ["TODO", "RUNNING", "BLOCKED"],
  RUNNING: ["READY", "DONE", "BLOCKED"],
  DONE: ["READY"],
  BLOCKED: ["TODO", "READY"],
};

export function canTransitionOfOperationStatus(from: OfOperationStatus, to: OfOperationStatus): boolean {
  if (from === to) return true;
  return OF_OPERATION_STATUS_TRANSITIONS[from].includes(to);
}

// Le réordonnancement de séquence (DnD) n'est licite qu'avant lancement et
// tant qu'aucune opération n'a démarré : la dépendance de phase est la vérité.
export const OF_OPERATION_REORDERABLE_STATUSES: readonly OfOperationStatus[] = ["TODO", "READY"];

export function ofOperationsAllowReorder(statuses: readonly string[]): boolean {
  return statuses.every((s) => (OF_OPERATION_REORDERABLE_STATUSES as readonly string[]).includes(s));
}
