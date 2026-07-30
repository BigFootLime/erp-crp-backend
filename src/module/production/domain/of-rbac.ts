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
  | "quality_decision"
  | "cancel"
  | "archive"
  | "traceability"
  // Versioning, replanification, AR et document (#374).
  | "revise"
  | "visa"
  | "plan_draft"
  | "plan_validate"
  | "ar_recalage"
  | "document";

const NEEDLES: Record<OfCapability, readonly string[]> = {
  read: ["admin", "administrateur", "directeur", "production", "atelier", "method", "planif", "program", "qualit", "secr", "secret", "logisti"],
  create: ["admin", "administrateur", "directeur", "production", "method"],
  generate: ["admin", "administrateur", "directeur", "production", "method"],
  edit_prelaunch: ["admin", "administrateur", "directeur", "production", "method"],
  launch: ["admin", "administrateur", "directeur", "production"],
  operate: ["admin", "administrateur", "directeur", "production", "atelier"],
  receipt: ["admin", "administrateur", "directeur", "production", "atelier", "logisti", "qualit"],
  quality_decision: ["admin", "administrateur", "directeur", "production", "qualit"],
  cancel: ["admin", "administrateur", "directeur", "production"],
  archive: ["admin", "administrateur", "directeur"],
  traceability: ["admin", "administrateur", "directeur", "production", "atelier", "qualit", "method", "logisti"],

  // ------------------------------------------------------------------------
  // Versioning, replanification, AR et document (#370).
  //
  // `req.user.role` porte le rôle EFFECTIF multi-rôles construit à la connexion
  // par `authorizationRole()` : une chaîne « Production | Atelier | Method »
  // d'ALIAS, jamais les intitulés d'organigramme. Le vocabulaire est donc fermé :
  //
  //   Directeur · Employee · Administrateur Systeme et Reseau · Responsable Qualité
  //   Secretaire · Responsable Programmation · Responsable RH · Commercial · Achat
  //   Comptabilite · Production · Atelier · Method · Planification · Logistique
  //   Maintenance · Stock · Magasin · Opérateur atelier
  //
  // Toute needle est choisie DANS ce vocabulaire. Deux needles de la première
  // écriture n'y correspondaient à RIEN et donnaient l'illusion d'une couverture :
  //   - « plann » : le rôle d'organigramme « Planning » s'alias en
  //     « Planification » ; « planif » couvre donc les deux, « plann » jamais.
  //   - « assistant » : « Assistante polyvalente » s'alias en « Secretaire » ;
  //     « secr » la couvre déjà.
  // Elles sont retirées. Aucun accès n'est perdu, une fausse garantie disparaît.
  // ------------------------------------------------------------------------

  // Réviser un OF touche à la définition technique : méthodes et programmation,
  // pas l'atelier — un opérateur exécute la gamme, il ne la réécrit pas.
  revise: ["admin", "administrateur", "directeur", "production", "method", "program"],
  // Le VISA est la signature de celui qui a fait la phase : l'atelier vise.
  // « Opérateur atelier » est couvert par la needle « atelier ».
  visa: ["admin", "administrateur", "directeur", "production", "atelier"],
  // Retoucher un planning est ouvert largement ; ce n'est qu'un brouillon.
  plan_draft: ["admin", "administrateur", "directeur", "production", "method", "planif", "atelier"],
  // Le valider ne l'est pas : c'est la décision qui engage la charge et le client.
  plan_validate: ["admin", "administrateur", "directeur", "production", "planif"],
  // Recaler un AR est un acte commercial : administration des ventes et direction.
  ar_recalage: ["admin", "administrateur", "directeur", "commerc", "secr", "secret"],
  // Éditer le document officiel de fabrication : tous ceux qui le lisent en atelier.
  document: ["admin", "administrateur", "directeur", "production", "atelier", "method", "program", "planif", "qualit"],
};

/**
 * Repli des diacritiques avant comparaison.
 *
 * Les « needles » sont écrites sans accent (`method`, `qualit`, `secr`) alors que
 * le catalogue de rôles en porte : « Études-Méthodes », « Responsable Qualité ».
 * Sans ce repli, `"études-méthodes".includes("method")` est faux et le rôle
 * Méthodes se voit refuser les capacités qui lui sont manifestement destinées —
 * un refus silencieux, sans erreur, donc invisible jusqu'à ce qu'un utilisateur
 * signale ne pas pouvoir créer d'OF.
 *
 * Ce repli **élargit** l'accès des rôles accentués aux capacités que la liste
 * leur destinait déjà. Il ne fait entrer aucun rôle qui n'était pas visé.
 */
function foldRole(role: string): string {
  return role
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
}

export function roleHasOfCapability(role: string | null | undefined, capability: OfCapability): boolean {
  if (hasGrantedAccountModuleAccess()) return true;
  const normalized = foldRole(role ?? "");
  if (!normalized) return false;
  return NEEDLES[capability].some((needle) => normalized.includes(foldRole(needle)));
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
import { hasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
