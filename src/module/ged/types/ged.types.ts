// GED centrale CERP (ADR-0037) — types exposés.
//
// RÈGLE DE CONTRAT : aucun de ces types ne porte `storage_path`, `storage_key`
// ni `stored_name`. Le chemin physique ne quitte jamais le serveur. Un test de
// contrat balaie l'ensemble des réponses pour le garantir.

import type { GedVersionStatus } from "../domain/ged-policy";

export type GedDocumentClass = {
  class_key: string;
  domain: string;
  label: string;
  nature: "SOURCE" | "GENERATED" | "EVIDENCE" | "REPRESENTATION";
  allowed_mime_types: string[];
  allowed_extensions: string[];
  max_size_bytes: number;
  approvals_required: number;
  retention_months: number | null;
  hold_on_publish: boolean;
  is_active: boolean;
};

export type GedActorLite = {
  id: number;
  username: string | null;
  label: string;
} | null;

/** Métadonnées non sensibles d'une version. Le chemin réel n'est jamais exposé. */
export type GedDocumentVersion = {
  id: string;
  document_id: string;
  version_number: number;
  status: GedVersionStatus;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  change_reason: string | null;
  created_at: string;
  created_by: GedActorLite;
  submitted_at: string | null;
  approved_at: string | null;
  approved_by: GedActorLite;
  published_at: string | null;
  obsoleted_at: string | null;
};

export type GedDocumentLink = {
  id: string;
  entity_type: string;
  entity_id: string;
  link_role: string | null;
  created_at: string;
};

export type GedRetentionHold = {
  id: string;
  hold_type: "QUALITE" | "LEGAL" | "RETENTION";
  reason: string;
  placed_at: string;
  released_at: string | null;
};

export type GedDocumentSummary = {
  id: string;
  code: string;
  class_key: string;
  class_label: string;
  domain: string;
  title: string;
  description: string | null;
  current_version_number: number | null;
  current_version_status: GedVersionStatus | null;
  versions_count: number;
  has_active_hold: boolean;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type GedDocumentDetail = GedDocumentSummary & {
  current_version: GedDocumentVersion | null;
  versions: GedDocumentVersion[];
  links: GedDocumentLink[];
  holds: GedRetentionHold[];
  active_checkout: {
    id: string;
    held_by: GedActorLite;
    reason: string;
    checked_out_at: string;
    expires_at: string;
  } | null;
};

export type GedTreeNode = {
  key: string;
  label: string;
  kind: "DOMAIN" | "CLASS";
  documents_count: number;
  children: GedTreeNode[];
};

export type GedListFilters = {
  q?: string | null;
  class_key?: string | null;
  domain?: string | null;
  status?: GedVersionStatus | null;
  entity_type?: string | null;
  entity_id?: string | null;
  include_archived?: boolean;
  page: number;
  page_size: number;
};

export type GedListResult = {
  items: GedDocumentSummary[];
  total: number;
  page: number;
  page_size: number;
};

export type GedAccessEvent = {
  id: string;
  event_type: string;
  actor: GedActorLite;
  occurred_at: string;
  details: Record<string, unknown> | null;
};
