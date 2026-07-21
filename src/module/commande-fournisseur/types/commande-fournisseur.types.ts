import type { CommandeFournisseurStatut } from "../domain/commande-fournisseur-transitions";

export type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  page_size: number;
};

export type CommandeFournisseurOrigine =
  | "MANUEL"
  | "SEUIL_STOCK"
  | "RUPTURE_OF"
  | "PROPOSITION_MRP"
  | "SOUS_TRAITANCE"
  | "AUTRE";

export type CommandeFournisseurLigneType =
  | "ARTICLE"
  | "MATIERE"
  | "COMPOSANT"
  | "SOUS_TRAITANCE"
  | "PRESTATION"
  | "LIBRE_CONTROLEE";

export type FournisseurMini = {
  id: string;
  code: string | null;
  nom: string | null;
  status: string | null;
  actif: boolean | null;
};

export type CommandeFournisseurListItem = {
  id: string;
  code: string;
  statut: CommandeFournisseurStatut;
  origine: CommandeFournisseurOrigine;
  fournisseur: FournisseurMini;
  devise: string;
  date_besoin: string | null;
  date_promesse: string | null;
  date_envoi: string | null;
  en_retard: boolean;
  nb_lignes: number;
  qty_commandee: number;
  qty_recue: number;
  /** null quand le rôle n'a pas la capacité `prices` (masquage serveur). */
  total_ht: number | null;
  total_ttc: number | null;
  version_document: number;
  created_at: string;
  updated_at: string;
};

export type CommandeFournisseurLigne = {
  id: string;
  commande_id: string;
  position: number;
  type: CommandeFournisseurLigneType;
  article_id: string | null;
  article_code: string | null;
  article_designation: string | null;
  catalogue_id: string | null;
  reference_fournisseur: string | null;
  designation: string;
  designation_interne: string | null;
  unite: string | null;
  unite_stock: string | null;
  coef_conversion: number | null;
  quantite: number;
  prix_unitaire_ht: number | null;
  remise_pct: number | null;
  tva_pct: number | null;
  frais_ht: number | null;
  net_ht: number | null;
  date_besoin: string | null;
  date_promesse: string | null;
  delai_jours: number | null;
  affaire_id: number | null;
  commande_client_id: number | null;
  of_id: number | null;
  piece_technique_id: string | null;
  operation_libelle: string | null;
  magasin_id: string | null;
  exigences_qualite: unknown[];
  documents_attendus: string[];
  qty_confirmee: number | null;
  qty_recue: number;
  qty_recue_nc: number;
  qty_annulee: number;
  qty_restante: number;
  statut_ligne: "ACTIVE" | "ANNULEE";
  motif_annulation: string | null;
  besoins: CommandeFournisseurLigneBesoin[];
};

export type CommandeFournisseurLigneBesoin = {
  id: string;
  besoin_type: "PIECE_TECHNIQUE_ACHAT" | "STOCK_LEVEL" | "MANUEL";
  besoin_ref: string;
  of_id: number | null;
  quantite_couverte: number;
  annule: boolean;
};

export type CommandeFournisseurTransitionEntry = {
  id: string;
  from_statut: CommandeFournisseurStatut | null;
  to_statut: CommandeFournisseurStatut;
  motif: string | null;
  acteur_id: number | null;
  acteur_nom: string | null;
  created_at: string;
};

export type CommandeFournisseurDocumentMeta = {
  id: string;
  version: number;
  titre: string;
  sha256: string;
  motif_revision: string | null;
  generated_by: number | null;
  created_at: string;
  sent_at: string | null;
};

export type CommandeFournisseurReceptionLiee = {
  reception_id: string;
  reception_no: string;
  status: string;
  reception_date: string;
  lignes: Array<{
    reception_ligne_id: string;
    commande_fournisseur_ligne_id: string | null;
    article_id: string;
    qty_received: number;
    lot_id: string | null;
    lot_status: string | null;
  }>;
};

export type CommandeFournisseur = {
  id: string;
  code: string;
  statut: CommandeFournisseurStatut;
  origine: CommandeFournisseurOrigine;
  fournisseur: FournisseurMini;
  contact_id: string | null;
  adresse_commande_id: string | null;
  magasin_livraison_id: string | null;
  adresse_livraison_texte: string | null;
  adresse_facturation_texte: string | null;
  devise: string;
  conditions_paiement: string | null;
  incoterm: string | null;
  mode_transport: string | null;
  date_besoin: string | null;
  date_promesse: string | null;
  date_envoi: string | null;
  date_accuse: string | null;
  date_cloture: string | null;
  date_annulation: string | null;
  reference_fournisseur: string | null;
  commentaire_public: string | null;
  note_interne: string | null;
  motif_revision: string | null;
  motif_annulation: string | null;
  motif_cloture: string | null;
  version_document: number;
  fournisseur_snapshot: Record<string, unknown> | null;
  conditions_snapshot: Record<string, unknown> | null;
  total_ht: number | null;
  total_remise: number | null;
  total_tva: number | null;
  frais_port_ht: number | null;
  tva_frais_pct: number | null;
  total_ttc: number | null;
  prices_masked: boolean;
  allowed_transitions: CommandeFournisseurStatut[];
  lignes: CommandeFournisseurLigne[];
  transitions: CommandeFournisseurTransitionEntry[];
  documents: CommandeFournisseurDocumentMeta[];
  receptions: CommandeFournisseurReceptionLiee[];
  created_at: string;
  updated_at: string;
  created_by: number | null;
  submitted_by: number | null;
  approved_by: number | null;
  sent_by: number | null;
};

export type CommandeFournisseurKpis = {
  brouillons: number;
  a_valider: number;
  a_envoyer: number;
  sans_accuse: number;
  en_retard: number;
  a_recevoir: number;
};

/** Une proposition d'achat expliquée, avant toute écriture. */
export type PropositionLigne = {
  besoin_type: "PIECE_TECHNIQUE_ACHAT" | "STOCK_LEVEL";
  besoin_ref: string;
  of_id: number | null;
  of_numero: string | null;
  article_id: string | null;
  article_code: string | null;
  designation: string;
  type: CommandeFournisseurLigneType;
  quantite: number;
  unite: string | null;
  prix_unitaire_ht: number | null;
  prix_source: string | null;
  delai_jours: number | null;
  date_besoin: string | null;
  catalogue_id: string | null;
  alertes: string[];
};

export type PropositionGroupe = {
  fournisseur: FournisseurMini;
  devise: string;
  lignes: PropositionLigne[];
  total_estime_ht: number | null;
};

export type PropositionsPreview = {
  groupes: PropositionGroupe[];
  bloques: Array<PropositionLigne & { raison: string }>;
  genere_le: string;
};
