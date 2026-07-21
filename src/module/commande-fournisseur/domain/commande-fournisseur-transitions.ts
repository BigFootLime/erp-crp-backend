/**
 * Machine d'état serveur des commandes fournisseurs (#172).
 *
 * Le statut n'est jamais posé librement via un PATCH générique : toute évolution passe par
 * une transition explicite validée ici (pattern affaire #169). `ANNULEE` et `CLOTUREE` sont
 * terminaux. Les états de réception (`PARTIELLEMENT_RECUE`, `RECUE`) sont DÉRIVÉS des
 * réceptions réelles saisies par un humain dans le module réceptions : ils ne s'atteignent
 * jamais par une transition manuelle arbitraire (voir `isReceptionDerivedStatus`).
 * Aucune suppression physique : l'annulation/clôture conserve la ligne et la traçabilité.
 */

export const COMMANDE_FOURNISSEUR_STATUTS = [
  "BROUILLON",
  "A_VALIDER",
  "APPROUVEE",
  "ENVOYEE",
  "ACCUSE_RECU",
  "PARTIELLEMENT_RECUE",
  "RECUE",
  "CLOTUREE",
  "ANNULEE",
] as const;

export type CommandeFournisseurStatut = (typeof COMMANDE_FOURNISSEUR_STATUTS)[number];

export const COMMANDE_FOURNISSEUR_TRANSITIONS: Record<
  CommandeFournisseurStatut,
  readonly CommandeFournisseurStatut[]
> = {
  BROUILLON: ["A_VALIDER", "ANNULEE"],
  A_VALIDER: ["APPROUVEE", "BROUILLON", "ANNULEE"],
  APPROUVEE: ["ENVOYEE", "BROUILLON", "ANNULEE"],
  ENVOYEE: ["ACCUSE_RECU", "PARTIELLEMENT_RECUE", "RECUE", "ANNULEE"],
  ACCUSE_RECU: ["PARTIELLEMENT_RECUE", "RECUE", "ANNULEE"],
  PARTIELLEMENT_RECUE: ["RECUE", "CLOTUREE"],
  RECUE: ["CLOTUREE"],
  CLOTUREE: [], // terminal
  ANNULEE: [], // terminal
};

export const COMMANDE_FOURNISSEUR_TERMINAL_STATUTS: readonly CommandeFournisseurStatut[] = [
  "CLOTUREE",
  "ANNULEE",
];

export function isTerminalStatut(statut: CommandeFournisseurStatut): boolean {
  return COMMANDE_FOURNISSEUR_TERMINAL_STATUTS.includes(statut);
}

export function isAllowedTransition(
  from: CommandeFournisseurStatut,
  to: CommandeFournisseurStatut
): boolean {
  if (from === to) return false;
  return (COMMANDE_FOURNISSEUR_TRANSITIONS[from] ?? []).includes(to);
}

export function allowedTargetsFrom(
  from: CommandeFournisseurStatut
): readonly CommandeFournisseurStatut[] {
  return COMMANDE_FOURNISSEUR_TRANSITIONS[from] ?? [];
}

/** Les états de réception sont dérivés des réceptions liées, jamais choisis à la main. */
export function isReceptionDerivedStatut(statut: CommandeFournisseurStatut): boolean {
  return statut === "PARTIELLEMENT_RECUE" || statut === "RECUE";
}

/**
 * Nature métier d'une transition — route vers la capacité RBAC distincte et enrichit l'audit.
 * `receive_partial`/`receive_full` ne sont émises que par l'imputation de réception (système).
 */
export type CommandeFournisseurTransitionKind =
  | "submit"
  | "reject"
  | "reopen_draft"
  | "approve"
  | "send"
  | "acknowledge"
  | "receive_partial"
  | "receive_full"
  | "close"
  | "cancel";

export function classifyTransition(
  from: CommandeFournisseurStatut,
  to: CommandeFournisseurStatut
): CommandeFournisseurTransitionKind {
  if (to === "ANNULEE") return "cancel";
  if (to === "CLOTUREE") return "close";
  if (to === "A_VALIDER") return "submit";
  if (to === "APPROUVEE") return "approve";
  if (to === "ENVOYEE") return "send";
  if (to === "ACCUSE_RECU") return "acknowledge";
  if (to === "PARTIELLEMENT_RECUE") return "receive_partial";
  if (to === "RECUE") return "receive_full";
  if (to === "BROUILLON" && from === "A_VALIDER") return "reject";
  return "reopen_draft"; // APPROUVEE -> BROUILLON (réédition motivée avant envoi)
}

/** Transitions dont le motif est obligatoire (auditabilité). */
export function transitionRequiresMotif(kind: CommandeFournisseurTransitionKind): boolean {
  return kind === "cancel" || kind === "reject" || kind === "reopen_draft" || kind === "close";
}
