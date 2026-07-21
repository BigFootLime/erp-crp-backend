import type { AffaireTransitionKind } from "./affaire-transitions";

/**
 * Capacités RBAC distinctes de l'affaire (#169) — refus par défaut. Chaque capacité correspond à
 * un ensemble de rôles (recherche par sous-chaîne, cohérente avec le modèle de rôles existant).
 * L'autorisation est vérifiée côté serveur, indépendamment de la visibilité des boutons.
 */
export type AffaireCapability =
  | "read"
  | "write"
  | "allocate"
  | "transition"
  | "close"
  | "reopen"
  | "archive"
  | "finance";

const CAPABILITY_ROLE_NEEDLES: Record<AffaireCapability, readonly string[]> = {
  // Lecture large : tous les métiers de l'atelier + support. (Refus si aucun rôle connu.)
  read: [
    "admin",
    "administrateur",
    "directeur",
    "secr",
    "secret",
    "commercial",
    "logistique",
    "production",
    "atelier",
    "compt",
    "qualit",
    "achat",
    "planif",
    "program",
    "magasin",
    "lecture",
    "viewer",
    "read",
  ],
  write: ["admin", "administrateur", "directeur", "secr", "secret", "commercial", "logistique", "production", "atelier", "compt"],
  allocate: ["admin", "administrateur", "directeur", "production", "atelier", "logistique", "program", "planif"],
  transition: ["admin", "administrateur", "directeur", "commercial", "logistique", "production", "atelier"],
  close: ["admin", "administrateur", "directeur", "commercial"],
  reopen: ["admin", "administrateur", "directeur"],
  archive: ["admin", "administrateur", "directeur"],
  finance: ["admin", "administrateur", "directeur", "compt", "commercial"],
};

export function roleHasAffaireCapability(role: string | null | undefined, capability: AffaireCapability): boolean {
  if (!role) return false;
  const normalized = role.trim().toLowerCase();
  if (!normalized) return false;
  return CAPABILITY_ROLE_NEEDLES[capability].some((needle) => normalized.includes(needle));
}

/** Capacité fine requise pour une transition, selon sa nature. */
export function capabilityForTransition(kind: AffaireTransitionKind): AffaireCapability {
  switch (kind) {
    case "close":
      return "close";
    case "reopen":
      return "reopen";
    case "cancel":
      return "archive";
    default:
      return "transition";
  }
}
