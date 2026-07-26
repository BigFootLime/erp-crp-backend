// Traçabilité industrielle 360 (#142 / front #276) — modèle contrôlé, sans I/O.
//
// Ce fichier définit le VOCABULAIRE de la généalogie : types de nœuds, types de
// relations, niveaux de preuve, sensibilité. Rien ici ne parle à PostgreSQL ni à
// Express : c'est le contrat partagé entre le moteur, l'API et l'UI.
//
// Règle fondatrice (ADR-0028) : le module Traçabilité est une VUE DE LECTURE
// transversale. Les tables métier restent propriétaires de leurs données. Aucun
// type ici ne crée une seconde source de vérité ; chaque relation est déclarée
// avec la façon dont elle est PROUVÉE.

/* -------------------------------------------------------------------------- */
/* 1) Types de nœuds                                                          */
/* -------------------------------------------------------------------------- */

export const TRACEABILITY_NODE_TYPES = [
  // Amont achat
  "fournisseur",
  "commande_fournisseur",
  "commande_fournisseur_ligne",
  "reception_fournisseur",
  "reception_ligne",
  "reception_inspection",
  // Référentiel technique
  "article",
  "piece_technique",
  "piece_version",
  // Matière et stock
  "lot",
  "stock_movement",
  "stock_movement_line",
  "reservation",
  // Production
  "of",
  "of_operation",
  "pointage",
  "machine",
  "poste",
  "of_receipt",
  "material_consumption",
  // Qualité / métrologie
  "quality_control",
  "quality_measurement",
  "non_conformity",
  "quality_action",
  "derogation",
  "release_decision",
  "metrology_equipment",
  "metrology_certificate",
  // Commerce et livraison
  "devis",
  "commande",
  "commande_ligne",
  "affaire",
  "bon_livraison",
  "bon_livraison_ligne",
  "delivery_proof",
  "client",
  // Preuves
  "document",
  "asbuilt_pack",
] as const;

export type TraceabilityNodeType = (typeof TRACEABILITY_NODE_TYPES)[number];

const NODE_TYPE_SET: ReadonlySet<string> = new Set(TRACEABILITY_NODE_TYPES);

export function isTraceabilityNodeType(value: unknown): value is TraceabilityNodeType {
  return typeof value === "string" && NODE_TYPE_SET.has(value);
}

/**
 * Types acceptés par le contrat HISTORIQUE `GET /traceability/chain`.
 * Ils restent valides : aucun écran en production ne doit casser.
 */
export const LEGACY_TRACEABILITY_NODE_TYPES = [
  "devis",
  "commande",
  "affaire",
  "of",
  "lot",
  "bon_livraison",
  "non_conformity",
] as const;

export type LegacyTraceabilityNodeType = (typeof LEGACY_TRACEABILITY_NODE_TYPES)[number];

export const NODE_TYPE_LABELS: Readonly<Record<TraceabilityNodeType, string>> = {
  fournisseur: "Fournisseur",
  commande_fournisseur: "Commande fournisseur",
  commande_fournisseur_ligne: "Ligne de commande fournisseur",
  reception_fournisseur: "Réception fournisseur",
  reception_ligne: "Ligne de réception",
  reception_inspection: "Inspection entrante",
  article: "Article",
  piece_technique: "Pièce technique",
  piece_version: "Version technique",
  lot: "Lot",
  stock_movement: "Mouvement de stock",
  stock_movement_line: "Ligne de mouvement",
  reservation: "Réservation",
  of: "Ordre de fabrication",
  of_operation: "Opération",
  pointage: "Pointage",
  machine: "Machine",
  poste: "Poste",
  of_receipt: "Réception de production",
  material_consumption: "Consommation matière",
  quality_control: "Contrôle qualité",
  quality_measurement: "Mesure",
  non_conformity: "Non-conformité",
  quality_action: "Action / CAPA",
  derogation: "Dérogation",
  release_decision: "Décision de libération",
  metrology_equipment: "Instrument de mesure",
  metrology_certificate: "Certificat métrologique",
  devis: "Devis",
  commande: "Commande client",
  commande_ligne: "Ligne de commande client",
  affaire: "Affaire",
  bon_livraison: "Bon de livraison",
  bon_livraison_ligne: "Ligne de bon de livraison",
  delivery_proof: "Preuve de livraison",
  client: "Client",
  document: "Document",
  asbuilt_pack: "Dossier as-built",
};

/**
 * Famille d'affichage : l'UI regroupe les nœuds par espace (Amont, Production,
 * Qualité, Stock, Livraison, Preuves) sans réinventer la sémantique côté client.
 */
export const NODE_TYPE_FAMILIES = [
  "achat",
  "technique",
  "stock",
  "production",
  "qualite",
  "commerce",
  "livraison",
  "preuve",
] as const;
export type TraceabilityNodeFamily = (typeof NODE_TYPE_FAMILIES)[number];

export const NODE_TYPE_FAMILY: Readonly<Record<TraceabilityNodeType, TraceabilityNodeFamily>> = {
  fournisseur: "achat",
  commande_fournisseur: "achat",
  commande_fournisseur_ligne: "achat",
  reception_fournisseur: "achat",
  reception_ligne: "achat",
  reception_inspection: "qualite",
  article: "technique",
  piece_technique: "technique",
  piece_version: "technique",
  lot: "stock",
  stock_movement: "stock",
  stock_movement_line: "stock",
  reservation: "stock",
  of: "production",
  of_operation: "production",
  pointage: "production",
  machine: "production",
  poste: "production",
  of_receipt: "production",
  material_consumption: "production",
  quality_control: "qualite",
  quality_measurement: "qualite",
  non_conformity: "qualite",
  quality_action: "qualite",
  derogation: "qualite",
  release_decision: "qualite",
  metrology_equipment: "qualite",
  metrology_certificate: "qualite",
  devis: "commerce",
  commande: "commerce",
  commande_ligne: "commerce",
  affaire: "commerce",
  bon_livraison: "livraison",
  bon_livraison_ligne: "livraison",
  delivery_proof: "livraison",
  client: "commerce",
  document: "preuve",
  asbuilt_pack: "preuve",
};

/* -------------------------------------------------------------------------- */
/* 2) Types de relations                                                      */
/* -------------------------------------------------------------------------- */

export const TRACEABILITY_RELATION_TYPES = [
  "ORDERED_FROM",
  "RECEIVED_IN",
  "RECEPTION_LINE_OF",
  "CREATED_LOT",
  "ISSUED_FROM",
  "INSPECTED_BY",
  "CONSUMED_BY",
  "MATERIAL_INPUT_OF",
  "PRODUCED_BY",
  "CHILD_OF",
  "USES_VERSION",
  "OF_OPERATION_OF",
  "EXECUTED_ON",
  "CLOCKED_IN",
  "CONTROLLED_BY",
  "MEASURED_IN",
  "MEASURED_WITH",
  "CERTIFIED_BY",
  "AFFECTED_BY_NC",
  "CORRECTED_BY",
  "COVERED_BY_DEROGATION",
  "RELEASED_BY",
  "BLOCKED_BY",
  "MOVED_BY",
  "MOVEMENT_LINE_OF",
  "RESERVED_FOR",
  "ALLOCATED_TO",
  "DELIVERY_LINE_OF",
  "DELIVERED_IN",
  "DELIVERED_TO",
  "PROVEN_BY",
  "DOCUMENTED_BY",
  "SPLIT_FROM",
  "MERGED_FROM",
  "TRANSFORMED_FROM",
  "COMPENSATES",
  "SUPERSEDES",
  "ORDER_LINE_OF",
  "BELONGS_TO_AFFAIRE",
  "QUOTED_BY",
  "ORDERED_BY",
  "ARTICLE_OF",
  "LEGACY_LINK",
] as const;

export type TraceabilityRelationType = (typeof TRACEABILITY_RELATION_TYPES)[number];

const RELATION_TYPE_SET: ReadonlySet<string> = new Set(TRACEABILITY_RELATION_TYPES);

export function isTraceabilityRelationType(value: unknown): value is TraceabilityRelationType {
  return typeof value === "string" && RELATION_TYPE_SET.has(value);
}

/**
 * Libellés lisibles par un opérateur. `label` se lit « source LABEL cible »,
 * `inverse_label` se lit « cible INVERSE source ». Les deux existent parce que
 * l'UI affiche la même arête depuis les deux extrémités.
 */
export const RELATION_LABELS: Readonly<
  Record<TraceabilityRelationType, { label: string; inverse: string }>
> = {
  ORDERED_FROM: { label: "a reçu la commande", inverse: "commandé auprès de" },
  RECEIVED_IN: { label: "réceptionné par", inverse: "reçu dans" },
  RECEPTION_LINE_OF: { label: "contient la ligne", inverse: "ligne de réception de" },
  CREATED_LOT: { label: "a créé le lot", inverse: "issu de" },
  ISSUED_FROM: { label: "a produit", inverse: "issu de" },
  INSPECTED_BY: { label: "inspecté par", inverse: "inspection de" },
  CONSUMED_BY: { label: "consommé par", inverse: "a consommé" },
  MATERIAL_INPUT_OF: { label: "entrée matière de", inverse: "alimenté par" },
  PRODUCED_BY: { label: "a produit", inverse: "produit par" },
  CHILD_OF: { label: "a pour enfant", inverse: "OF enfant de" },
  USES_VERSION: { label: "utilise la version", inverse: "version utilisée par" },
  OF_OPERATION_OF: { label: "comporte l'opération", inverse: "opération de" },
  EXECUTED_ON: { label: "exécuté sur", inverse: "a exécuté" },
  CLOCKED_IN: { label: "pointé dans", inverse: "a reçu le pointage" },
  CONTROLLED_BY: { label: "contrôlé par", inverse: "contrôle de" },
  MEASURED_IN: { label: "mesuré dans", inverse: "comporte la mesure" },
  MEASURED_WITH: { label: "mesuré avec", inverse: "a servi à mesurer" },
  CERTIFIED_BY: { label: "certifié par", inverse: "certificat de" },
  AFFECTED_BY_NC: { label: "concerné par une NC", inverse: "concerne" },
  CORRECTED_BY: { label: "traité par", inverse: "action de" },
  COVERED_BY_DEROGATION: { label: "couvert par la dérogation", inverse: "couvre" },
  RELEASED_BY: { label: "libéré par", inverse: "a libéré" },
  BLOCKED_BY: { label: "bloqué par", inverse: "a bloqué" },
  MOVED_BY: { label: "déplacé par", inverse: "a déplacé" },
  MOVEMENT_LINE_OF: { label: "comporte la ligne", inverse: "ligne du mouvement" },
  RESERVED_FOR: { label: "réservé pour", inverse: "a réservé" },
  ALLOCATED_TO: { label: "alloué à", inverse: "a reçu l'allocation" },
  DELIVERY_LINE_OF: { label: "comporte la ligne", inverse: "ligne du bon de livraison" },
  DELIVERED_IN: { label: "livré dans", inverse: "a livré" },
  DELIVERED_TO: { label: "livré au client", inverse: "a reçu la livraison" },
  PROVEN_BY: { label: "prouvé par", inverse: "preuve de" },
  DOCUMENTED_BY: { label: "documenté par", inverse: "document de" },
  SPLIT_FROM: { label: "fractionné en", inverse: "fractionné depuis" },
  MERGED_FROM: { label: "fusionné dans", inverse: "fusionné depuis" },
  TRANSFORMED_FROM: { label: "transformé en", inverse: "transformé depuis" },
  COMPENSATES: { label: "compensé par", inverse: "compense" },
  SUPERSEDES: { label: "remplacé par", inverse: "remplace" },
  ORDER_LINE_OF: { label: "comporte la ligne", inverse: "ligne de commande de" },
  BELONGS_TO_AFFAIRE: { label: "rattaché à l'affaire", inverse: "regroupe" },
  QUOTED_BY: { label: "chiffré par", inverse: "a chiffré" },
  ORDERED_BY: { label: "commandé par", inverse: "a commandé" },
  ARTICLE_OF: { label: "article de", inverse: "porte l'article" },
  LEGACY_LINK: { label: "lien historique", inverse: "lien historique" },
};

export function relationLabel(relation: TraceabilityRelationType): string {
  return RELATION_LABELS[relation]?.label ?? relation;
}

export function relationInverseLabel(relation: TraceabilityRelationType): string {
  return RELATION_LABELS[relation]?.inverse ?? relation;
}

/* -------------------------------------------------------------------------- */
/* 3) Niveaux de preuve                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `proven`   : la relation existe par clé étrangère, mouvement comptabilisé,
 *              snapshot signé ou enregistrement métier autoritaire.
 * `declared` : la relation est DÉCLARÉE par un champ de référence documentaire
 *              (ex. `stock_movements.source_document_type` + `source_document_id`)
 *              sans contrainte référentielle. Vraie, mais non contrainte.
 * `unknown`  : origine non renseignée. On l'affiche, on ne l'invente jamais.
 *
 * Il est INTERDIT de fabriquer une relation par rapprochement de codes, de
 * textes, de dates proches, d'articles similaires ou de quantités supposées.
 */
export const TRACEABILITY_PROOF_LEVELS = ["proven", "declared", "unknown"] as const;
export type TraceabilityProofLevel = (typeof TRACEABILITY_PROOF_LEVELS)[number];

export const PROOF_LEVEL_LABELS: Readonly<Record<TraceabilityProofLevel, string>> = {
  proven: "Prouvé",
  declared: "Déclaré",
  unknown: "Lien historique non renseigné",
};

/* -------------------------------------------------------------------------- */
/* 4) Références de nœud et identité opaque                                   */
/* -------------------------------------------------------------------------- */

export type TraceabilityNodeRef = {
  type: TraceabilityNodeType;
  id: string;
};

export function nodeKey(ref: TraceabilityNodeRef): string {
  return `${ref.type}:${ref.id}`;
}

export function parseNodeKey(key: string): TraceabilityNodeRef | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  const type = key.slice(0, idx);
  const id = key.slice(idx + 1);
  if (!isTraceabilityNodeType(type) || !id) return null;
  return { type, id };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

export function isBigintId(value: string): boolean {
  return /^[0-9]{1,18}$/.test(value.trim());
}

/**
 * Les identifiants internes ne sont JAMAIS l'identité présentée à l'opérateur :
 * la fiche affiche `code`, l'URL technique porte `node_id`. Cette fonction dit
 * si un identifiant est plausible pour un type donné, ce qui évite d'envoyer un
 * UUID là où PostgreSQL attend un bigint (et inversement) — un cast raté est
 * une erreur 500, pas une réponse « introuvable ».
 */
const UUID_KEYED: ReadonlySet<TraceabilityNodeType> = new Set<TraceabilityNodeType>([
  "fournisseur",
  "commande_fournisseur",
  "commande_fournisseur_ligne",
  "reception_fournisseur",
  "reception_ligne",
  "reception_inspection",
  "article",
  "piece_technique",
  "piece_version",
  "lot",
  "stock_movement",
  "stock_movement_line",
  "reservation",
  "of_operation",
  "pointage",
  "machine",
  "poste",
  "of_receipt",
  "material_consumption",
  "quality_control",
  "quality_measurement",
  "non_conformity",
  "quality_action",
  "derogation",
  "release_decision",
  "metrology_equipment",
  "metrology_certificate",
  "bon_livraison",
  "bon_livraison_ligne",
  "delivery_proof",
  "document",
  "asbuilt_pack",
]);

const BIGINT_KEYED: ReadonlySet<TraceabilityNodeType> = new Set<TraceabilityNodeType>([
  "of",
  "devis",
  "commande",
  "commande_ligne",
  "affaire",
]);

export function nodeIdShapeIsValid(ref: TraceabilityNodeRef): boolean {
  const id = ref.id.trim();
  if (!id) return false;
  if (UUID_KEYED.has(ref.type)) return isUuid(id);
  if (BIGINT_KEYED.has(ref.type)) return isBigintId(id);
  // `client` porte un code métier court (client_id varchar(3)).
  if (ref.type === "client") return id.length <= 32;
  return true;
}

/* -------------------------------------------------------------------------- */
/* 5) Routes vers la fiche autoritaire                                        */
/* -------------------------------------------------------------------------- */

/**
 * La traçabilité n'agit jamais : elle RENVOIE vers le module propriétaire.
 * `null` = pas d'écran dédié aujourd'hui (le nœud reste lisible dans le
 * panneau de détail, mais on ne fabrique pas une route qui n'existe pas).
 */
export function authoritativeRoute(ref: TraceabilityNodeRef): string | null {
  const id = encodeURIComponent(ref.id);
  switch (ref.type) {
    case "fournisseur":
      return `/fournisseurs/${id}`;
    case "commande_fournisseur":
      return `/commandes-fournisseurs/${id}`;
    case "reception_fournisseur":
      return `/receptions/${id}`;
    case "article":
      return `/articles/${id}`;
    case "piece_technique":
      return `/pieces-techniques/${id}`;
    case "of":
      return `/production/of/${id}`;
    case "machine":
      return `/machines/${id}`;
    case "quality_control":
      return `/qualite/controles/${id}`;
    case "non_conformity":
      return `/qualite/non-conformites/${id}`;
    case "derogation":
      return `/qualite/derogations/${id}`;
    case "metrology_equipment":
      return `/metrologie/equipements/${id}`;
    case "devis":
      return `/devis/${id}`;
    case "commande":
      return `/commandes/${id}`;
    case "affaire":
      return `/affaires/${id}`;
    case "bon_livraison":
      return `/livraisons/${id}`;
    case "client":
      return `/clients/${id}`;
    case "lot":
      return `/stock/lots/${id}`;
    case "stock_movement":
      return `/stock/mouvements/${id}`;
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 6) Direction de parcours                                                   */
/* -------------------------------------------------------------------------- */

export const TRACEABILITY_DIRECTIONS = ["upstream", "downstream", "both"] as const;
export type TraceabilityDirection = (typeof TRACEABILITY_DIRECTIONS)[number];

/** Direction portée par une arête produite par le repository. */
export type EdgeDirection = "upstream" | "downstream" | "lateral";

/* -------------------------------------------------------------------------- */
/* 7) Anomalies de qualité de données                                         */
/* -------------------------------------------------------------------------- */

export const DATA_QUALITY_CODES = [
  "LOT_WITHOUT_ORIGIN",
  "CONSUMPTION_WITHOUT_POSTED_MOVEMENT",
  "OF_WITHOUT_TECHNICAL_SNAPSHOT",
  "SNAPSHOT_HASH_MISSING",
  "MANUFACTURED_LOT_WITHOUT_RECEIPT",
  "DELIVERY_WITHOUT_ALLOCATION",
  "ALLOCATION_WITHOUT_OUTBOUND_MOVEMENT",
  "CONTROL_WITHOUT_OBJECT",
  "MEASUREMENT_WITHOUT_INSTRUMENT",
  "MEASUREMENT_WITHOUT_VALID_CERTIFICATE",
  "DOCUMENT_MISSING",
  "ORPHAN_RELATION",
  "QUANTITY_INCONSISTENT",
  "CYCLE_DETECTED",
  "LEGACY_IMPORT_INCOMPLETE",
  "TRUNCATED_BY_LIMITS",
  "TRUNCATED_BY_PERMISSIONS",
] as const;

export type DataQualityCode = (typeof DATA_QUALITY_CODES)[number];

export const DATA_QUALITY_LABELS: Readonly<Record<DataQualityCode, string>> = {
  LOT_WITHOUT_ORIGIN: "Lot sans origine prouvée",
  CONSUMPTION_WITHOUT_POSTED_MOVEMENT: "Consommation sans mouvement comptabilisé",
  OF_WITHOUT_TECHNICAL_SNAPSHOT: "OF sans version technique figée",
  SNAPSHOT_HASH_MISSING: "Empreinte de snapshot manquante",
  MANUFACTURED_LOT_WITHOUT_RECEIPT: "Lot fabriqué sans réception de production",
  DELIVERY_WITHOUT_ALLOCATION: "Bon de livraison sans allocation de lot",
  ALLOCATION_WITHOUT_OUTBOUND_MOVEMENT: "Allocation sans mouvement de sortie",
  CONTROL_WITHOUT_OBJECT: "Contrôle sans objet rattaché",
  MEASUREMENT_WITHOUT_INSTRUMENT: "Mesure sans instrument déclaré",
  MEASUREMENT_WITHOUT_VALID_CERTIFICATE: "Mesure sans certificat valide à la date",
  DOCUMENT_MISSING: "Document introuvable",
  ORPHAN_RELATION: "Relation orpheline",
  QUANTITY_INCONSISTENT: "Quantité incohérente",
  CYCLE_DETECTED: "Cycle détecté dans la généalogie",
  LEGACY_IMPORT_INCOMPLETE: "Historique importé incomplet (CLIPPER)",
  TRUNCATED_BY_LIMITS: "Résultat tronqué par les limites serveur",
  TRUNCATED_BY_PERMISSIONS: "Résultat tronqué par vos autorisations",
};

export type DataQualityIssue = {
  code: DataQualityCode;
  level: "info" | "warning" | "danger";
  node_id: string | null;
  message: string;
  details?: Record<string, unknown> | null;
};

/* -------------------------------------------------------------------------- */
/* 8) Couverture d'analyse d'impact                                           */
/* -------------------------------------------------------------------------- */

export const IMPACT_CLASSIFICATIONS = [
  "CONFIRMED",
  "TO_ANALYSE",
  "NO_PROVEN_IMPACT",
  "OUT_OF_SCOPE",
  "INSUFFICIENT_DATA",
] as const;
export type ImpactClassification = (typeof IMPACT_CLASSIFICATIONS)[number];

export const IMPACT_CLASSIFICATION_LABELS: Readonly<Record<ImpactClassification, string>> = {
  CONFIRMED: "Impact confirmé",
  TO_ANALYSE: "À analyser",
  NO_PROVEN_IMPACT: "Sans impact prouvé",
  OUT_OF_SCOPE: "Hors périmètre",
  INSUFFICIENT_DATA: "Données insuffisantes",
};
