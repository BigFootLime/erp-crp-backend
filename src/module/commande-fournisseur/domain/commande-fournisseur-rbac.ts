import type { CommandeFournisseurTransitionKind } from "./commande-fournisseur-transitions";

/**
 * Capacités RBAC distinctes des commandes fournisseurs (#172) — refus par défaut.
 * Chaque capacité correspond à un ensemble de rôles (recherche par sous-chaîne, cohérente
 * avec le modèle de rôles existant — aucun rôle inventé : Directeur, Administrateur Systeme
 * et Reseau, Secretaire, Responsable Programmation, Responsable Qualité, Employee…).
 * L'autorisation est vérifiée côté serveur, indépendamment de la visibilité des boutons.
 *
 * `prices` protège les prix/totaux d'achat (donnée commercialement sensible) ;
 * `over_receipt` protège la sur-réception ; `close` couvre la clôture avec reliquat.
 */
export type CommandeFournisseurCapability =
  | "read"
  | "create"
  | "update_draft"
  | "submit"
  | "approve"
  | "send"
  | "acknowledge"
  | "cancel"
  | "close"
  | "export"
  | "prices"
  | "over_receipt";

const CAPABILITY_ROLE_NEEDLES: Record<CommandeFournisseurCapability, readonly string[]> = {
  // Lecture : métiers concernés par les achats (refus si aucun rôle connu — Employee ne lit pas).
  read: [
    "admin",
    "administrateur",
    "directeur",
    "secr",
    "secret",
    "achat",
    "logistique",
    "magasin",
    "compt",
    "qualit",
    "program",
    "planif",
    "commercial",
  ],
  create: ["admin", "administrateur", "directeur", "secr", "secret", "achat", "program", "logistique"],
  update_draft: ["admin", "administrateur", "directeur", "secr", "secret", "achat", "program", "logistique"],
  submit: ["admin", "administrateur", "directeur", "secr", "secret", "achat", "program", "logistique"],
  // Approbation = engagement de dépense : périmètre resserré.
  approve: ["admin", "administrateur", "directeur"],
  send: ["admin", "administrateur", "directeur", "secr", "secret", "achat"],
  acknowledge: ["admin", "administrateur", "directeur", "secr", "secret", "achat", "logistique"],
  cancel: ["admin", "administrateur", "directeur"],
  close: ["admin", "administrateur", "directeur", "achat"],
  export: ["admin", "administrateur", "directeur", "secr", "secret", "achat", "compt"],
  prices: ["admin", "administrateur", "directeur", "secr", "secret", "achat", "compt", "program"],
  over_receipt: ["admin", "administrateur", "directeur", "qualit"],
};

export function roleHasCommandeFournisseurCapability(
  role: string | null | undefined,
  capability: CommandeFournisseurCapability
): boolean {
  if (!role) return false;
  const normalized = role.trim().toLowerCase();
  if (!normalized) return false;
  return CAPABILITY_ROLE_NEEDLES[capability].some((needle) => normalized.includes(needle));
}

/** Capacité fine requise pour une transition, selon sa nature. */
export function capabilityForTransition(
  kind: CommandeFournisseurTransitionKind
): CommandeFournisseurCapability {
  switch (kind) {
    case "submit":
      return "submit";
    case "approve":
    case "reject":
      return "approve";
    case "reopen_draft":
      return "update_draft";
    case "send":
      return "send";
    case "acknowledge":
      return "acknowledge";
    case "close":
      return "close";
    case "cancel":
      return "cancel";
    default:
      // receive_partial / receive_full : dérivées des réceptions, jamais manuelles.
      return "cancel";
  }
}
