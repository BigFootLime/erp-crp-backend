// Traçabilité industrielle 360 (#142) — politique d'accès, sans I/O.
//
// Refus par défaut. Un utilisateur authentifié n'obtient AUCUN droit implicite
// sur la généalogie : le module traverse le stock, la production, la qualité,
// la métrologie, l'ADV et la livraison, donc il est le point le plus exposé de
// l'ERP à la divulgation transversale.
//
// Deux garanties distinctes cohabitent ici :
//   1. la CAPACITÉ (puis-je appeler cette opération ?)
//   2. la VISIBILITÉ DE NŒUD (ai-je le droit de voir CE type d'objet ?)
// La seconde est celle qui empêche une relation de révéler l'existence d'un
// objet interdit : un nœud masqué est retiré du graphe AVEC ses arêtes, il
// n'apparaît jamais sous forme d'ombre « objet 42 inaccessible ».

import { HttpError } from "../../../utils/httpError";

import type { TraceabilityNodeType } from "./traceability-model";

/* -------------------------------------------------------------------------- */
/* 1) Capacités                                                               */
/* -------------------------------------------------------------------------- */

export const TRACEABILITY_CAPABILITIES = [
  "read",
  "search",
  "impact",
  "export",
  "audit",
  "documents_read",
  "asbuilt_generate",
  "asbuilt_download",
  "personal_data_read",
  "financial_read",
  "customer_data_read",
  "supplier_data_read",
] as const;

export type TraceabilityCapability = (typeof TRACEABILITY_CAPABILITIES)[number];

// Les rôles CERP sont du texte libre en base. On reprend la mécanique par
// « needles » déjà utilisée par `quality-policy.ts`, `metrology-policy.ts`,
// `of-rbac.ts` et `machine-rbac.ts` plutôt que d'inventer une table parallèle.
//
// `admin technique` n'obtient volontairement AUCUN accès implicite aux données
// métier sensibles : « informatique » / « technicien si » n'apparaissent nulle
// part. Administrer le système n'est pas lire les prix client.
const CAPABILITY_NEEDLES: Record<TraceabilityCapability, readonly string[]> = {
  // Lire la chaîne est le socle : atelier, magasin, qualité, méthodes, ADV,
  // direction. C'est la valeur du module — sans lecture, il n'existe pas.
  read: [
    "admin",
    "administrateur",
    "directeur",
    "direction",
    "qualit",
    "quality",
    "qse",
    "metrolog",
    "métrolog",
    "production",
    "atelier",
    "method",
    "magasin",
    "stock",
    "logistic",
    "adv",
    "commerc",
    "achat",
  ],
  search: [
    "admin",
    "administrateur",
    "directeur",
    "direction",
    "qualit",
    "quality",
    "qse",
    "metrolog",
    "métrolog",
    "production",
    "atelier",
    "method",
    "magasin",
    "stock",
    "logistic",
    "adv",
    "commerc",
    "achat",
  ],
  // Simuler un impact, c'est préparer une décision qualité : pas l'atelier.
  impact: [
    "admin",
    "administrateur",
    "directeur",
    "direction",
    "qualit",
    "quality",
    "qse",
    "metrolog",
    "métrolog",
    "method",
  ],
  // Sortir des données de l'ERP est un acte tracé et restreint.
  export: ["admin", "administrateur", "directeur", "direction", "qualit", "quality", "qse"],
  audit: ["admin", "administrateur", "directeur", "direction", "qualit", "quality", "qse"],
  documents_read: [
    "admin",
    "administrateur",
    "directeur",
    "direction",
    "qualit",
    "quality",
    "qse",
    "metrolog",
    "métrolog",
    "method",
    "production",
    "atelier",
  ],
  asbuilt_generate: [
    "admin",
    "administrateur",
    "directeur",
    "direction",
    "qualit",
    "quality",
    "qse",
  ],
  asbuilt_download: [
    "admin",
    "administrateur",
    "directeur",
    "direction",
    "qualit",
    "quality",
    "qse",
    "adv",
    "commerc",
  ],
  // RGPD : voir QUI a pointé est une donnée personnelle, pas une preuve
  // industrielle. La preuve, c'est le pointage ; le nom, c'est un droit à part.
  personal_data_read: [
    "admin",
    "administrateur",
    "directeur",
    "direction",
    "rh",
    "responsable_rh",
    "qualit",
    "quality",
    "qse",
  ],
  financial_read: [
    "admin",
    "administrateur",
    "directeur",
    "direction",
    "compta",
    "financ",
    "adv",
    "commerc",
  ],
  customer_data_read: [
    "admin",
    "administrateur",
    "directeur",
    "direction",
    "adv",
    "commerc",
    "qualit",
    "quality",
    "qse",
    "logistic",
  ],
  supplier_data_read: [
    "admin",
    "administrateur",
    "directeur",
    "direction",
    "achat",
    "approvision",
    "qualit",
    "quality",
    "qse",
    "magasin",
    "stock",
  ],
};

export function roleHasTraceabilityCapability(
  role: string | null | undefined,
  capability: TraceabilityCapability
): boolean {
  if (hasGrantedAccountModuleAccess()) return true;
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return false;
  const needles = CAPABILITY_NEEDLES[capability];
  if (!needles) return false;
  return needles.some((needle) => normalized.includes(needle));
}

export function assertTraceabilityCapability(
  role: string | null | undefined,
  capability: TraceabilityCapability
): void {
  if (!roleHasTraceabilityCapability(role, capability)) {
    throw new HttpError(
      403,
      "TRACEABILITY_CAPABILITY_REQUIRED",
      `La capacité Traçabilité '${capability}' est requise.`
    );
  }
}

export type TraceabilityCapabilitySet = Readonly<Record<TraceabilityCapability, boolean>>;

export function capabilitiesForRole(role: string | null | undefined): TraceabilityCapabilitySet {
  const out = {} as Record<TraceabilityCapability, boolean>;
  for (const cap of TRACEABILITY_CAPABILITIES) {
    out[cap] = roleHasTraceabilityCapability(role, cap);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 2) Visibilité par type de nœud                                             */
/* -------------------------------------------------------------------------- */

/**
 * Capacité additionnelle exigée pour qu'un TYPE de nœud soit visible.
 * `null` = visible dès que `read` est accordé.
 *
 * Un nœud non visible est SUPPRIMÉ du graphe (nœud + arêtes) et compté dans
 * `coverage.hidden_by_permission`. On ne renvoie jamais un placeholder qui
 * révélerait l'existence de l'objet : c'est exactement le vecteur d'IDOR par
 * inférence que ce module doit fermer.
 */
const NODE_VISIBILITY: Partial<Record<TraceabilityNodeType, TraceabilityCapability>> = {
  fournisseur: "supplier_data_read",
  commande_fournisseur: "supplier_data_read",
  commande_fournisseur_ligne: "supplier_data_read",
  client: "customer_data_read",
  devis: "financial_read",
  commande: "customer_data_read",
  commande_ligne: "customer_data_read",
  document: "documents_read",
  metrology_certificate: "documents_read",
  asbuilt_pack: "documents_read",
  pointage: "read",
};

export function nodeTypeIsVisible(
  caps: TraceabilityCapabilitySet,
  type: TraceabilityNodeType
): boolean {
  if (!caps.read) return false;
  const required = NODE_VISIBILITY[type];
  if (!required) return true;
  return caps[required] === true;
}

export function requiredCapabilityForNodeType(
  type: TraceabilityNodeType
): TraceabilityCapability | null {
  return NODE_VISIBILITY[type] ?? null;
}

/* -------------------------------------------------------------------------- */
/* 3) Masquage de champs                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Un pointage EST une preuve industrielle (qui-quoi-quand sur une opération),
 * mais le NOM de l'opérateur est une donnée personnelle. Sans
 * `personal_data_read`, on garde la preuve et on remplace l'identité par un
 * pseudonyme stable non réversible côté client (`Opérateur #<id>`), pour que la
 * chaîne reste vérifiable sans exposer la personne.
 */
export function maskOperatorLabel(
  caps: TraceabilityCapabilitySet,
  operatorUserId: number | null,
  operatorLabel: string | null
): string | null {
  if (operatorUserId === null && !operatorLabel) return null;
  if (caps.personal_data_read) return operatorLabel ?? (operatorUserId ? `#${operatorUserId}` : null);
  return operatorUserId ? `Opérateur #${operatorUserId}` : "Opérateur";
}

/** Les montants ne sortent jamais sans `financial_read`. */
export function maskAmount(caps: TraceabilityCapabilitySet, amount: number | null): number | null {
  if (!caps.financial_read) return null;
  return amount;
}

/* -------------------------------------------------------------------------- */
/* 4) Bornes serveur                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Plafonds NON contournables par la requête. Le client peut demander moins,
 * jamais plus : un graphe massif est un déni de service et une fuite de volume.
 */
export const TRACEABILITY_LIMITS = {
  MAX_DEPTH: 8,
  DEFAULT_DEPTH: 4,
  MAX_NODES: 600,
  DEFAULT_NODES: 150,
  MAX_EDGES: 2400,
  DEFAULT_EDGES: 600,
  MAX_NEIGHBORS_PER_NODE: 60,
  SEARCH_MAX_LIMIT: 50,
  SEARCH_DEFAULT_LIMIT: 20,
  IMPACT_MAX_ITEMS: 500,
  STATEMENT_TIMEOUT_MS: 8000,
} as const;

export function clampDepth(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return TRACEABILITY_LIMITS.DEFAULT_DEPTH;
  return Math.max(0, Math.min(TRACEABILITY_LIMITS.MAX_DEPTH, Math.trunc(value)));
}

export function clampNodes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return TRACEABILITY_LIMITS.DEFAULT_NODES;
  return Math.max(1, Math.min(TRACEABILITY_LIMITS.MAX_NODES, Math.trunc(value)));
}

export function clampEdges(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return TRACEABILITY_LIMITS.DEFAULT_EDGES;
  return Math.max(1, Math.min(TRACEABILITY_LIMITS.MAX_EDGES, Math.trunc(value)));
}

export function clampSearchLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TRACEABILITY_LIMITS.SEARCH_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(TRACEABILITY_LIMITS.SEARCH_MAX_LIMIT, Math.trunc(value)));
}
import { hasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
