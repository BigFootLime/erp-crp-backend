// RBAC OF (#170) — capacités distinctes par action, refus par défaut,
// même mécanique par « needles » de rôle que machine-rbac.ts.
// La lecture des OF reste volontairement au niveau JWT dans les routes
// historiques (planning, commandes et affaires consomment ces lectures) ;
// toute mutation passe par une capacité explicite ci-dessous.

export type OfCapability =
  | "read"
  | "create"
  | "generate"
  | "edit_prelaunch"
  | "launch"
  | "operate"
  | "receipt"
  | "cancel"
  | "archive"
  | "traceability";

const NEEDLES: Record<OfCapability, readonly string[]> = {
  read: ["admin", "administrateur", "directeur", "production", "atelier", "method", "planif", "program", "qualit", "secr", "secret", "logisti"],
  create: ["admin", "administrateur", "directeur", "production", "method"],
  generate: ["admin", "administrateur", "directeur", "production", "method"],
  edit_prelaunch: ["admin", "administrateur", "directeur", "production", "method"],
  launch: ["admin", "administrateur", "directeur", "production"],
  operate: ["admin", "administrateur", "directeur", "production", "atelier"],
  receipt: ["admin", "administrateur", "directeur", "production", "atelier", "logisti"],
  cancel: ["admin", "administrateur", "directeur", "production"],
  archive: ["admin", "administrateur", "directeur"],
  traceability: ["admin", "administrateur", "directeur", "production", "atelier", "qualit", "method", "logisti"],
};

export function roleHasOfCapability(role: string | null | undefined, capability: OfCapability): boolean {
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return NEEDLES[capability].some((needle) => normalized.includes(needle));
}

import type { OfStatut } from "./of-status";

// Capacité exigée pour une transition de statut donnée (contrôleur → 403).
export function capabilityForOfTransition(_from: OfStatut, to: OfStatut): OfCapability {
  switch (to) {
    case "ANNULE":
      return "cancel";
    case "CLOTURE":
      return "archive";
    case "EN_COURS":
    case "EN_PAUSE":
    case "TERMINE":
      return "launch";
    default:
      return "edit_prelaunch";
  }
}
