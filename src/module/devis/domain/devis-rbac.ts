import type { DevisStatut } from "../lib/status";

/**
 * Capacités RBAC distinctes du domaine Devis (#167) — refus par défaut.
 * Même modèle que commandes fournisseurs (#172) : chaque capacité correspond à un
 * ensemble de rôles reconnus par sous-chaîne (aucun rôle inventé — Directeur,
 * Administrateur Systeme et Reseau, Secretaire, Responsable Programmation,
 * Responsable Qualité, Employee…). L'autorisation est vérifiée côté serveur,
 * indépendamment de la visibilité des boutons (ISO A.5.15 default-deny).
 *
 * `decide` couvre l'issue commerciale (accepter/refuser/expirer un devis envoyé) ;
 * `convert` couvre la conversion contrôlée en commande client ; `export` couvre
 * documents et téléchargements (le devis porte des prix — donnée sensible).
 */
export type DevisCapability =
  | "read"
  | "create"
  | "update_draft"
  | "submit"
  | "decide"
  | "cancel"
  | "revise"
  | "convert"
  | "export"
  | "delete";

const CAPABILITY_ROLE_NEEDLES: Record<DevisCapability, readonly string[]> = {
  // Lecture : métiers concernés par le cycle commercial (Employee ne lit pas — prix).
  read: [
    "admin",
    "administrateur",
    "directeur",
    "secr",
    "secret",
    "commercial",
    "compt",
    "program",
    "planif",
    "qualit",
    "charge d'affaires",
    "charge d affaires",
  ],
  create: ["admin", "administrateur", "directeur", "secr", "secret", "commercial"],
  update_draft: ["admin", "administrateur", "directeur", "secr", "secret", "commercial"],
  submit: ["admin", "administrateur", "directeur", "secr", "secret", "commercial"],
  // Issue commerciale = engagement : périmètre resserré.
  decide: ["admin", "administrateur", "directeur", "commercial"],
  cancel: ["admin", "administrateur", "directeur"],
  revise: ["admin", "administrateur", "directeur", "secr", "secret", "commercial"],
  convert: ["admin", "administrateur", "directeur", "secr", "secret", "commercial"],
  export: ["admin", "administrateur", "directeur", "secr", "secret", "commercial", "compt"],
  delete: ["admin", "administrateur", "directeur"],
};

export function roleHasDevisCapability(role: string | null | undefined, capability: DevisCapability): boolean {
  if (!role) return false;
  const normalized = role.trim().toLowerCase();
  if (!normalized) return false;
  return CAPABILITY_ROLE_NEEDLES[capability].some((needle) => normalized.includes(needle));
}

/**
 * Capacité fine requise pour une transition de statut, selon sa nature.
 * La garde grossière (route) vérifie qu'au moins une capacité de transition existe ;
 * la capacité exacte est re-vérifiée dans le repository une fois l'état source connu.
 */
export function capabilityForDevisTransition(from: DevisStatut, to: DevisStatut): DevisCapability {
  if (to === "ANNULE") return "cancel";
  if (from === "BROUILLON" && to === "ENVOYE") return "submit";
  if (from === "EXPIRE" && to === "ENVOYE") return "submit";
  if (to === "BROUILLON") return "update_draft"; // réouverture REFUSE/EXPIRE -> BROUILLON
  // ENVOYE -> ACCEPTE / REFUSE / EXPIRE : issue commerciale.
  return "decide";
}

export const DEVIS_TRANSITION_CAPABILITIES: readonly DevisCapability[] = [
  "submit",
  "decide",
  "cancel",
  "update_draft",
];
