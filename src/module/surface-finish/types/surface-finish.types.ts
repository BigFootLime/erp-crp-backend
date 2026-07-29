// #210 — Contrats de sortie de la bibliothèque de finitions et de la résolution
// d'article. Ce sont les formes que le frontend consomme ; elles ne fuient
// jamais de chemin de stockage, ni de coût, ni d'identifiant interne inutile.

import type {
  CanonicalFinishSpec,
  FinishScope,
  SimilarityLevel,
  SurfaceFinishCapability,
  SurfaceFinishStatus,
} from "../domain/surface-finish-policy";

export type SurfaceFinishFamily = {
  code: string;
  label: string;
  description: string | null;
  sort_order: number;
  is_active: boolean;
};

export type SurfaceFinishRevisionSummary = {
  id: string;
  revision: number;
  statut: SurfaceFinishStatus;
  norme: string | null;
  classe: string | null;
  epaisseur_min: number | null;
  epaisseur_nominale: number | null;
  epaisseur_max: number | null;
  epaisseur_unite: string;
  couleur: string | null;
  teinte_ral: string | null;
  aspect: string | null;
  certificat_requis: boolean;
  date_effet: string | null;
  updated_at: string;
};

export type SurfaceFinishRevisionDetail = SurfaceFinishRevisionSummary & {
  finish_id: string;
  reference_client: string | null;
  substrat: string | null;
  brillance: string | null;
  rugosite: string | null;
  durete: string | null;
  exigence_corrosion: string | null;
  pretraitement: string | null;
  posttraitement: string | null;
  zones_defaut: string[];
  regles_masquage: string[];
  criteres_acceptation: string | null;
  controles: string[];
  certificat_type: string | null;
  conditionnement_retour: string | null;
  unite_achat: string;
  designation_template: string | null;
  commentaire_template: string | null;
  template_version: number;
  approbateur_user_id: number | null;
  approved_at: string | null;
  created_at: string;
};

export type SurfaceFinishSummary = {
  id: string;
  code: string;
  family_code: string;
  family_label: string | null;
  procede: string;
  designation_courte: string;
  designation_longue: string | null;
  synonymes: string[];
  statut: SurfaceFinishStatus;
  current_revision: SurfaceFinishRevisionSummary | null;
  updated_at: string;
  /** #226 — Favori de l'utilisateur qui interroge, jamais un favori partagé. */
  favori: boolean;
  archived_at: string | null;
  archive_reason: string | null;
};

export type SurfaceFinishDetail = SurfaceFinishSummary & {
  description: string | null;
  created_at: string;
  revisions: SurfaceFinishRevisionDetail[];
};

/* #226 — Contrôle des doublons du référentiel. */
export type SurfaceFinishSimilarMatch = {
  id: string;
  code: string;
  family_code: string;
  family_label: string | null;
  procede: string;
  designation_courte: string;
  designation_longue: string | null;
  synonymes: string[];
  statut: SurfaceFinishStatus;
  score: number;
  level: SimilarityLevel;
  /** Ce qui a déclenché le rapprochement, pour que l'écran puisse l'expliquer. */
  reasons: string[];
  current_revision: SurfaceFinishRevisionSummary | null;
};

/* #226 — Historique lu depuis erp_audit_logs, jamais reconstitué. */
export type SurfaceFinishHistoryEntry = {
  id: number;
  created_at: string;
  action: string;
  entity_type: string;
  entity_id: string;
  user_id: number | null;
  user_label: string | null;
  details: Record<string, unknown> | null;
};

export type SurfaceFinishListResult = {
  items: SurfaceFinishSummary[];
  total: number;
  page: number;
  page_size: number;
};

export type SurfaceFinishDocument = {
  id: string;
  revision_id: string;
  libelle: string;
  doc_type: string;
  ged_document_id: string | null;
  reference_externe: string | null;
  sha256: string | null;
  created_at: string;
};

/** Contexte lu côté serveur : jamais reconstruit depuis le corps de la requête. */
export type OperationFinishContext = {
  piece_technique_id: string;
  code_piece: string;
  designation_piece: string;
  piece_technique_version_id: string;
  indice: string;
  plan_reference: string | null;
  gamme_id: string;
  gamme_code: string | null;
  gamme_nom: string | null;
  gamme_statut: string;
  gamme_updated_at: string;
  gamme_editable: boolean;
  operation_id: string;
  numero_operation: number | null;
  designation_operation: string;
  type_operation: string | null;
  operation_updated_at: string | null;
};

export type ArticleMatch = {
  article_id: string;
  code: string;
  designation: string;
  is_active: boolean;
  status: string | null;
  spec_fingerprint: string | null;
  finish_revision_id: string | null;
  piece_technique_version_id: string | null;
  created_at: string;
};

export type ArticleNearMatch = ArticleMatch & {
  differences: Array<{ field: string; existing: unknown; proposed: unknown }>;
};

export type PlannedArticleClassification = {
  article_type: "PURCHASED";
  article_category: "traitement";
  article_categories: string[];
  cat_label: string;
  family_code: string;
  stock_managed: boolean;
  lot_tracking: boolean;
  code_hint: string;
};

export type PlannedPurchaseLine = {
  type_achat: "TRAITEMENT";
  quantite: number;
  unite: string;
  designation_snapshot: string;
  gamme_operation_id: string;
  piece_technique_version_id: string;
  existing_line_id: string | null;
};

export type SupplierCandidate = {
  fournisseur_id: string;
  fournisseur_nom: string;
  fournisseur_code: string | null;
  categorie: string | null;
  statut_qualification: string | null;
};

export type QualityRequirementPreview = {
  certificat_requis: boolean;
  certificat_type: string | null;
  controles: string[];
  criteres_acceptation: string | null;
  conditionnement: string | null;
};

export type SurfaceFinishPreview = {
  context: OperationFinishContext;
  finish: {
    id: string;
    code: string;
    designation_courte: string;
    family_code: string;
    procede: string;
    statut: SurfaceFinishStatus;
  };
  revision: SurfaceFinishRevisionDetail;
  spec_canonical: CanonicalFinishSpec;
  spec_fingerprint: string;
  generated_designation: string;
  generated_comment: string;
  omitted_comment_lines: string[];
  template_version: number;
  classification: PlannedArticleClassification;
  exact_match: ArticleMatch | null;
  near_matches: ArticleNearMatch[];
  purchase_line: PlannedPurchaseLine;
  suppliers: SupplierCandidate[];
  quality: QualityRequirementPreview;
  warnings: Array<{ code: string; message: string }>;
  capabilities: Record<SurfaceFinishCapability, boolean>;
  allowed_decisions: string[];
  preview_hash: string;
  generated_at: string;
};

export type OperationFinishRequirement = {
  id: string;
  gamme_id: string;
  gamme_operation_id: string;
  piece_technique_version_id: string;
  finish_revision_id: string;
  finish_id: string;
  finish_code: string;
  finish_designation: string;
  revision: number;
  revision_statut: SurfaceFinishStatus;
  perimetre: FinishScope;
  zones: string[];
  masquages: string[];
  instructions: string | null;
  spec_fingerprint: string;
  article_id: string | null;
  article_code: string | null;
  article_designation: string | null;
  achat_ligne_id: string | null;
  generated_designation: string;
  generated_comment: string;
  designation_override: string | null;
  comment_override: string | null;
  updated_at: string;
};

export type ConfirmFinishResult = {
  result: "CREATED" | "REUSED" | "LINKED";
  article: {
    id: string;
    code: string;
    designation: string;
    article_type: string;
    article_category: string;
    article_categories: string[];
    family_code: string;
    stock_managed: boolean;
    lot_tracking: boolean;
  };
  requirement: OperationFinishRequirement;
  purchase_line: {
    id: string;
    type_achat: string;
    quantite: number;
    designation_snapshot: string | null;
  };
  next_actions: Array<{ key: string; label: string; href: string }>;
};
