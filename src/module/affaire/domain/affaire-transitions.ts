import type { AffaireStatut } from "../validators/affaire.validators";

/**
 * Machine d'état serveur de l'affaire (#169).
 *
 * Le statut n'est jamais posé librement via un PATCH générique : toute évolution passe par une
 * transition explicite validée ici. `ANNULEE` est terminal. `CLOTUREE` n'autorise qu'une
 * réouverture auditée. Aucune suppression physique : l'archivage est une transition (`cancel`)
 * qui conserve la ligne et toute la traçabilité.
 */
export const AFFAIRE_TRANSITIONS: Record<AffaireStatut, readonly AffaireStatut[]> = {
  OUVERTE: ["EN_COURS", "SUSPENDUE", "CLOTUREE", "ANNULEE"],
  EN_COURS: ["SUSPENDUE", "CLOTUREE", "ANNULEE"],
  SUSPENDUE: ["OUVERTE", "EN_COURS", "CLOTUREE", "ANNULEE"],
  CLOTUREE: ["OUVERTE", "EN_COURS"], // réouverture auditée uniquement
  ANNULEE: [], // terminal
};

/** États terminaux : aucune nouvelle allocation / OF ne doit être créée (hors réouverture auditée). */
export const AFFAIRE_TERMINAL_STATUSES: readonly AffaireStatut[] = ["CLOTUREE", "ANNULEE"];

export function isTerminalStatus(statut: AffaireStatut): boolean {
  return AFFAIRE_TERMINAL_STATUSES.includes(statut);
}

export function isAllowedTransition(from: AffaireStatut, to: AffaireStatut): boolean {
  if (from === to) return false;
  return (AFFAIRE_TRANSITIONS[from] ?? []).includes(to);
}

export function allowedTargetsFrom(from: AffaireStatut): readonly AffaireStatut[] {
  return AFFAIRE_TRANSITIONS[from] ?? [];
}

/**
 * Nature métier d'une transition — sert à router vers la capacité RBAC distincte
 * (close / reopen / cancel / transition) et à enrichir l'audit.
 */
export type AffaireTransitionKind = "start" | "suspend" | "resume" | "close" | "reopen" | "cancel";

export function classifyTransition(from: AffaireStatut, to: AffaireStatut): AffaireTransitionKind {
  if (to === "ANNULEE") return "cancel";
  if (to === "CLOTUREE") return "close";
  if (from === "CLOTUREE") return "reopen";
  if (to === "SUSPENDUE") return "suspend";
  if (from === "SUSPENDUE" && (to === "OUVERTE" || to === "EN_COURS")) return "resume";
  return "start";
}
