export type ClientLite = {
  client_id: string;
  company_name: string;
  email: string | null;
  phone: string | null;
  delivery_address_id: string | null;
  bill_address_id: string | null;
};

export type CommandeHeaderLite = {
  id: number;
  numero: string;
  client_id: string;
  date_commande: string;
  total_ht: number;
  total_ttc: number;
  updated_at: string;
  statut: string;
};

export type DevisHeaderLite = {
  id: number;
  numero: string;
  client_id: string | null;
  date_creation: string;
  date_validite: string | null;
  statut: string;
  total_ht: number;
  total_ttc: number;
};

export type Affaire = {
  id: number;
  reference: string;
  client_id: string | null;
  commande_id: number | null;
  devis_id: number | null;
  type_affaire: string;
  statut: string;
  date_ouverture: string;
  date_cloture: string | null;
  commentaire: string | null;
  created_at: string;
  updated_at: string;
  client?: ClientLite | null;
  commande?: CommandeHeaderLite | null;
  devis?: DevisHeaderLite | null;
};

export type AffaireListItem = Omit<Affaire, "commande" | "devis">;

export type AffaireTraceabilitySource = {
  section: "affaire" | "commande" | "production" | "livraison" | "facturation" | "audit";
  source_table: string;
  source_id: number | string | null;
  source_ref?: string | null;
  status?: string | null;
  updated_at?: string | null;
  evidence_count?: number | null;
};

export type AffaireCommandCenterItem = {
  id: number;
  reference: string;
  statut: string;
  client: ClientLite | null;
  commande: {
    id: number | null;
    numero: string | null;
    statut: string | null;
    workflow_status: string | null;
    total_ht: number | null;
    date_commande: string | null;
  };
  production: {
    of_count: number;
    open_count: number;
    blocked_count: number;
    completed_count: number;
    latest_status: string | null;
    completion_rate: number;
  };
  livraison: {
    bl_count: number;
    partial_count: number;
    delivered_count: number;
    latest_status: string | null;
    latest_date: string | null;
    tracking_number: string | null;
  };
  facturation: {
    facture_count: number;
    paid_count: number;
    unpaid_count: number;
    avoir_count: number;
    total_ht: number;
    total_ttc: number;
    paid_amount: number;
    open_amount: number;
  };
  control: {
    active_checkpoint_count: number;
    blocked_checkpoint_count: number;
    active_checkpoint_labels: string[];
    last_workflow_event_at: string | null;
    audit_event_count: number;
    last_audit_at: string | null;
  };
  status: {
    production: "none" | "waiting" | "in_progress" | "blocked" | "completed";
    livraison: "none" | "ready" | "partial" | "delivered";
    facturation: "none" | "to_invoice" | "partial" | "paid";
  };
  next_action: string;
  risk_flags: string[];
  traceability: AffaireTraceabilitySource[];
  date_ouverture: string;
  updated_at: string | null;
};

export type AffaireTimelineEvent = {
  source: "commande" | "livraison" | "audit";
  event_type: string;
  title: string;
  occurred_at: string;
  actor_id?: number | string | null;
  actor_name?: string | null;
  source_id?: number | string | null;
  details?: Record<string, unknown> | null;
};

export type AffaireOperationsDetail = {
  affaire: AffaireCommandCenterItem;
  allocations: Array<{
    id: number;
    commande_ligne_id: number;
    article_ref_id: string | null;
    article_legacy_id: number | null;
    qty_ordered: number;
    qty_from_stock: number;
    qty_reserved: number;
    qty_to_produce: number;
    allocation_mode: string | null;
    created_at: string;
    updated_at: string;
  }>;
  ordres_fabrication: Array<{
    id: number;
    numero: string;
    piece_technique_id: string;
    piece_code: string | null;
    piece_designation: string | null;
    statut: string;
    priority: string;
    quantite_lancee: number;
    quantite_bonne: number;
    quantite_rebut: number;
    total_ops: number;
    done_ops: number;
    date_lancement_prevue: string | null;
    date_fin_prevue: string | null;
    updated_at: string;
  }>;
  livraisons: Array<{
    id: string;
    numero: string;
    statut: string;
    date_creation: string;
    date_expedition: string | null;
    date_livraison: string | null;
    transporteur: string | null;
    tracking_number: string | null;
    updated_at: string;
  }>;
  factures: Array<{
    id: number;
    numero: string;
    statut: string;
    date_emission: string;
    date_echeance: string | null;
    total_ttc: number;
    paid_ttc: number;
    remaining_ttc: number;
    updated_at: string;
  }>;
  documents: Array<{
    source: "commande" | "livraison" | "facture";
    entity_id: string;
    document_id: string;
    type: string | null;
    document_name: string | null;
    created_at: string | null;
  }>;
  timeline: AffaireTimelineEvent[];
};

export type AffaireUpsertPayload = {
  reference?: string;
  client_id?: string | null;
  commande_id?: number | null;
  devis_id?: number | null;
  type_affaire?: string;
  statut?: string;
  date_ouverture?: string;
  date_cloture?: string | null;
  commentaire?: string | null;
};

export type AuditContext = {
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};
