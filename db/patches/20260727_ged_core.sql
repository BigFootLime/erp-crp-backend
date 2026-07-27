-- GED centrale CERP — noyau documentaire (ADR-0037).
--
-- STRICTEMENT ADDITIF : aucune table existante n'est modifiée, renommée ou vidée.
-- Aucun module actuel n'est rebranché par ce patch. Les mini-GED historiques
-- (pieces_techniques_documents, quality_documents, stock_documents, ...) continuent
-- de fonctionner exactement comme avant.
--
-- Le rattachement des tables historiques au noyau fera l'objet de patches ultérieurs,
-- un par module, chacun réversible.

BEGIN;

/* ------------------------------------------------------------------ */
/* 1) Référentiel des classes documentaires                            */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS public.ged_document_classes (
  class_key            text PRIMARY KEY,
  domain               text NOT NULL,
  label                text NOT NULL,
  nature               text NOT NULL CHECK (nature IN ('SOURCE', 'GENERATED', 'EVIDENCE', 'REPRESENTATION')),
  allowed_mime_types   text[] NOT NULL,
  allowed_extensions   text[] NOT NULL,
  max_size_bytes       bigint NOT NULL CHECK (max_size_bytes > 0),
  approvals_required   smallint NOT NULL DEFAULT 0 CHECK (approvals_required BETWEEN 0 AND 2),
  retention_months     integer NULL CHECK (retention_months IS NULL OR retention_months > 0),
  hold_on_publish      boolean NOT NULL DEFAULT false,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ged_document_classes IS
  'Unité de configuration de la GED : formats, taille, circuit d''approbation, rétention. Ajouter un type de document = ajouter une classe, jamais un if dans un service.';

/* ------------------------------------------------------------------ */
/* 2) Blobs — contenu physique adressé par empreinte                   */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS public.ged_blobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256         text NOT NULL UNIQUE CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes     bigint NOT NULL CHECK (size_bytes > 0),
  mime_type      text NOT NULL,
  storage_key    text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     integer NULL REFERENCES public.users(id) ON DELETE SET NULL
);

COMMENT ON COLUMN public.ged_blobs.storage_key IS
  'Clé interne opaque relative à la racine du coffre. N''est JAMAIS retournée par l''API.';

/* Un blob n'est jamais modifié : son identité EST son contenu. */
CREATE OR REPLACE FUNCTION public.fn_ged_blob_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes THEN
    RAISE EXCEPTION 'GED_BLOB_IMMUTABLE: le contenu d''un blob ne peut pas être modifié (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ged_blob_immutable ON public.ged_blobs;
CREATE TRIGGER trg_ged_blob_immutable
  BEFORE UPDATE ON public.ged_blobs
  FOR EACH ROW EXECUTE FUNCTION public.fn_ged_blob_immutable();

/* ------------------------------------------------------------------ */
/* 3) Documents — identité logique                                     */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS public.ged_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE,
  class_key         text NOT NULL REFERENCES public.ged_document_classes(class_key) ON UPDATE CASCADE,
  title             text NOT NULL CHECK (length(btrim(title)) > 0),
  description       text NULL,
  current_version_id uuid NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz NULL,
  archived_by       integer NULL REFERENCES public.users(id) ON DELETE SET NULL
);

COMMENT ON COLUMN public.ged_documents.code IS
  'Code documentaire immuable, jamais réutilisé même après archivage.';
COMMENT ON COLUMN public.ged_documents.archived_at IS
  'Suppression LOGIQUE uniquement. Aucune route ne supprime physiquement un document.';

CREATE INDEX IF NOT EXISTS idx_ged_documents_class ON public.ged_documents(class_key)
  WHERE archived_at IS NULL;

-- Recherche plein texte : `pg_trgm` a été écarté par 20260726_pieces_techniques_landing_146.
-- Un index fonctionnel sur le titre normalisé couvre le préfixe sans nouvelle extension.
CREATE INDEX IF NOT EXISTS idx_ged_documents_title_lower
  ON public.ged_documents(lower(title) text_pattern_ops);

/* Le code documentaire ne change jamais. */
CREATE OR REPLACE FUNCTION public.fn_ged_document_code_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'GED_CODE_IMMUTABLE: le code documentaire est immuable (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ged_document_code_immutable ON public.ged_documents;
CREATE TRIGGER trg_ged_document_code_immutable
  BEFORE UPDATE ON public.ged_documents
  FOR EACH ROW EXECUTE FUNCTION public.fn_ged_document_code_immutable();

/* ------------------------------------------------------------------ */
/* 4) Versions — le cœur du versionnement                              */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS public.ged_document_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       uuid NOT NULL REFERENCES public.ged_documents(id) ON DELETE RESTRICT,
  version_number    integer NOT NULL CHECK (version_number > 0),
  status            text NOT NULL DEFAULT 'BROUILLON'
                      CHECK (status IN ('BROUILLON', 'EN_REVUE', 'APPROUVE', 'APPLICABLE', 'OBSOLETE')),
  blob_id           uuid NOT NULL REFERENCES public.ged_blobs(id) ON DELETE RESTRICT,
  original_name     text NOT NULL,
  change_reason     text NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  submitted_at      timestamptz NULL,
  submitted_by      integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at       timestamptz NULL,
  approved_by       integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  published_at      timestamptz NULL,
  obsoleted_at      timestamptz NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_ged_versions_document ON public.ged_document_versions(document_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_ged_versions_blob ON public.ged_document_versions(blob_id);

/* Une seule version APPLICABLE par document, garantie par index partiel. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_ged_versions_single_applicable
  ON public.ged_document_versions(document_id)
  WHERE status = 'APPLICABLE';

ALTER TABLE public.ged_documents
  DROP CONSTRAINT IF EXISTS ged_documents_current_version_fkey;
ALTER TABLE public.ged_documents
  ADD CONSTRAINT ged_documents_current_version_fkey
  FOREIGN KEY (current_version_id) REFERENCES public.ged_document_versions(id) ON DELETE SET NULL;

/*
 * Immutabilité d'une version approuvée ou applicable.
 * Cette règle vit en base et non dans un service : elle doit survivre à un script,
 * à un correctif manuel et à une future route mal écrite.
 * Seules les transitions de statut prévues et l'horodatage restent permis.
 */
CREATE OR REPLACE FUNCTION public.fn_ged_version_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('APPROUVE', 'APPLICABLE', 'OBSOLETE') THEN
    IF NEW.blob_id        IS DISTINCT FROM OLD.blob_id
       OR NEW.version_number IS DISTINCT FROM OLD.version_number
       OR NEW.document_id IS DISTINCT FROM OLD.document_id
       OR NEW.original_name IS DISTINCT FROM OLD.original_name
       OR NEW.change_reason IS DISTINCT FROM OLD.change_reason
       OR NEW.created_by   IS DISTINCT FROM OLD.created_by
       OR NEW.approved_by  IS DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'GED_VERSION_IMMUTABLE: une version % ne peut plus être modifiée (id=%)', OLD.status, OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD.status = 'OBSOLETE' AND NEW.status <> 'OBSOLETE' THEN
    RAISE EXCEPTION 'GED_VERSION_IMMUTABLE: une version OBSOLETE ne peut pas être réactivée (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ged_version_immutable ON public.ged_document_versions;
CREATE TRIGGER trg_ged_version_immutable
  BEFORE UPDATE ON public.ged_document_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ged_version_immutable();

/* Séparation des tâches : le déposant n'approuve pas. */
CREATE OR REPLACE FUNCTION public.fn_ged_version_separation_of_duties()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.approved_by IS NOT NULL
     AND NEW.created_by IS NOT NULL
     AND NEW.approved_by = NEW.created_by THEN
    RAISE EXCEPTION 'GED_APPROVAL_SELF: le déposant d''une version ne peut pas l''approuver (version=%)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ged_version_separation_of_duties ON public.ged_document_versions;
CREATE TRIGGER trg_ged_version_separation_of_duties
  BEFORE INSERT OR UPDATE ON public.ged_document_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ged_version_separation_of_duties();

/* ------------------------------------------------------------------ */
/* 5) Liens métier — l'arborescence est calculée, jamais sur disque    */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS public.ged_document_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES public.ged_documents(id) ON DELETE CASCADE,
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  link_role    text NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  UNIQUE (document_id, entity_type, entity_id, link_role)
);

COMMENT ON TABLE public.ged_document_links IS
  'Un document peut apparaître à plusieurs endroits de l''arbre métier sans être dupliqué.';

CREATE INDEX IF NOT EXISTS idx_ged_links_entity ON public.ged_document_links(entity_type, entity_id);

/* ------------------------------------------------------------------ */
/* 6) Relations entre documents                                        */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS public.ged_document_relations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id uuid NOT NULL REFERENCES public.ged_documents(id) ON DELETE CASCADE,
  target_document_id uuid NOT NULL REFERENCES public.ged_documents(id) ON DELETE CASCADE,
  relation_type  text NOT NULL CHECK (relation_type IN ('DERIVED_FROM', 'REPLACES', 'ANNEX_OF', 'GENERATED_FROM')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CHECK (source_document_id <> target_document_id),
  UNIQUE (source_document_id, target_document_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_ged_relations_target ON public.ged_document_relations(target_document_id, relation_type);

/* ------------------------------------------------------------------ */
/* 7) Approbations                                                     */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS public.ged_approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id   uuid NOT NULL REFERENCES public.ged_document_versions(id) ON DELETE CASCADE,
  decision     text NOT NULL CHECK (decision IN ('SUBMITTED', 'APPROVED', 'REJECTED')),
  comment      text NULL,
  decided_at   timestamptz NOT NULL DEFAULT now(),
  decided_by   integer NULL REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ged_approvals_version ON public.ged_approvals(version_id, decided_at DESC);

/* ------------------------------------------------------------------ */
/* 8) Consignation (check-out / check-in)                              */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS public.ged_checkouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES public.ged_documents(id) ON DELETE CASCADE,
  held_by       integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reason        text NOT NULL CHECK (length(btrim(reason)) > 0),
  checked_out_at timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  released_at   timestamptz NULL,
  release_kind  text NULL CHECK (release_kind IN ('CHECKIN', 'ABANDON', 'EXPIRED')),
  CHECK (expires_at > checked_out_at)
);

/* Un seul verrou actif par document. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_ged_checkout_active
  ON public.ged_checkouts(document_id)
  WHERE released_at IS NULL;

/* ------------------------------------------------------------------ */
/* 9) Rétention et gels                                                */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS public.ged_retention_holds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES public.ged_documents(id) ON DELETE RESTRICT,
  hold_type    text NOT NULL CHECK (hold_type IN ('QUALITE', 'LEGAL', 'RETENTION')),
  reason       text NOT NULL CHECK (length(btrim(reason)) > 0),
  placed_at    timestamptz NOT NULL DEFAULT now(),
  placed_by    integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  released_at  timestamptz NULL,
  released_by  integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  release_reason text NULL
);

CREATE INDEX IF NOT EXISTS idx_ged_holds_document ON public.ged_retention_holds(document_id)
  WHERE released_at IS NULL;

/* Un gel actif bloque l'archivage, y compris administrateur. */
CREATE OR REPLACE FUNCTION public.fn_ged_document_hold_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.ged_retention_holds h
      WHERE h.document_id = NEW.id AND h.released_at IS NULL
    ) THEN
      RAISE EXCEPTION 'GED_RETENTION_HOLD: document sous gel, archivage refusé (id=%)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ged_document_hold_guard ON public.ged_documents;
CREATE TRIGGER trg_ged_document_hold_guard
  BEFORE UPDATE ON public.ged_documents
  FOR EACH ROW EXECUTE FUNCTION public.fn_ged_document_hold_guard();

/* ------------------------------------------------------------------ */
/* 10) Manifestes figés (OF, as-built)                                 */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS public.ged_snapshot_manifests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope          text NOT NULL CHECK (scope IN ('OF', 'ASBUILT', 'BL_PACK')),
  scope_id       text NOT NULL,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  frozen_at      timestamptz NOT NULL DEFAULT now(),
  frozen_by      integer NULL REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ged_manifests_scope ON public.ged_snapshot_manifests(scope, scope_id, frozen_at DESC);

CREATE TABLE IF NOT EXISTS public.ged_snapshot_manifest_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id  uuid NOT NULL REFERENCES public.ged_snapshot_manifests(id) ON DELETE RESTRICT,
  entry_role   text NOT NULL,
  version_id   uuid NOT NULL REFERENCES public.ged_document_versions(id) ON DELETE RESTRICT,
  sha256       text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  UNIQUE (manifest_id, entry_role, version_id)
);

/*
 * Un manifeste est figé. Un OF relancé produit un NOUVEAU manifeste, jamais une
 * modification de l'ancien. Même motif que fn_prevent_of_technical_snapshot_mutation.
 */
CREATE OR REPLACE FUNCTION public.fn_ged_manifest_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'GED_MANIFEST_IMMUTABLE: un manifeste figé ne peut être ni modifié ni supprimé'
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_ged_manifest_immutable ON public.ged_snapshot_manifests;
CREATE TRIGGER trg_ged_manifest_immutable
  BEFORE UPDATE OR DELETE ON public.ged_snapshot_manifests
  FOR EACH ROW EXECUTE FUNCTION public.fn_ged_manifest_immutable();

DROP TRIGGER IF EXISTS trg_ged_manifest_entries_immutable ON public.ged_snapshot_manifest_entries;
CREATE TRIGGER trg_ged_manifest_entries_immutable
  BEFORE UPDATE OR DELETE ON public.ged_snapshot_manifest_entries
  FOR EACH ROW EXECUTE FUNCTION public.fn_ged_manifest_immutable();

/* ------------------------------------------------------------------ */
/* 11) Sessions de dépôt (staging -> quarantaine -> publication)       */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS public.ged_upload_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_key     text NOT NULL REFERENCES public.ged_document_classes(class_key) ON UPDATE CASCADE,
  document_id   uuid NULL REFERENCES public.ged_documents(id) ON DELETE CASCADE,
  title         text NULL,
  status        text NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN', 'QUARANTINE', 'READY', 'PUBLISHED', 'EXPIRED', 'REJECTED')),
  staging_key   text NULL,
  sha256        text NULL CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes    bigint NULL,
  mime_type     text NULL,
  original_name text NULL,
  reject_reason text NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  expires_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ged_upload_sessions_open
  ON public.ged_upload_sessions(created_by, status)
  WHERE status IN ('OPEN', 'QUARANTINE', 'READY');

/* ------------------------------------------------------------------ */
/* 12) Journal d'accès — append-only                                   */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS public.ged_access_events (
  id           bigserial PRIMARY KEY,
  document_id  uuid NULL REFERENCES public.ged_documents(id) ON DELETE SET NULL,
  version_id   uuid NULL REFERENCES public.ged_document_versions(id) ON DELETE SET NULL,
  event_type   text NOT NULL CHECK (event_type IN (
                 'UPLOAD', 'READ', 'DOWNLOAD', 'SUBMIT', 'APPROVE', 'REJECT',
                 'PUBLISH', 'OBSOLETE', 'ARCHIVE', 'CHECKOUT', 'CHECKIN',
                 'HOLD_PLACED', 'HOLD_RELEASED', 'INTEGRITY_FAILURE')),
  actor_id     integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  details      jsonb NULL
);

COMMENT ON COLUMN public.ged_access_events.details IS
  'Ne doit contenir NI chemin, NI secret, NI contenu binaire, NI donnée personnelle superflue.';

CREATE INDEX IF NOT EXISTS idx_ged_access_events_document
  ON public.ged_access_events(document_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION public.fn_ged_access_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'GED_AUDIT_APPEND_ONLY: le journal d''accès GED est en écriture seule'
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_ged_access_events_append_only ON public.ged_access_events;
CREATE TRIGGER trg_ged_access_events_append_only
  BEFORE UPDATE OR DELETE ON public.ged_access_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_ged_access_events_append_only();

/* ------------------------------------------------------------------ */
/* 13) Amorce du référentiel de classes                                */
/* ------------------------------------------------------------------ */

INSERT INTO public.ged_document_classes
  (class_key, domain, label, nature, allowed_mime_types, allowed_extensions, max_size_bytes, approvals_required, retention_months, hold_on_publish)
VALUES
  ('PLAN_CLIENT', 'TECHNIQUE', 'Plan client', 'SOURCE',
   ARRAY['application/pdf','image/tiff'], ARRAY['.pdf','.tif','.tiff'], 104857600, 1, 120, false),
  ('MODELE_3D', 'TECHNIQUE', 'Modèle 3D / CAO', 'SOURCE',
   ARRAY['application/octet-stream','model/step','application/step'], ARRAY['.step','.stp','.iges','.igs','.stl'], 524288000, 1, 120, false),
  ('GAMME_DOC', 'TECHNIQUE', 'Gamme et instructions', 'SOURCE',
   ARRAY['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
   ARRAY['.pdf','.docx'], 26214400, 1, 120, false),
  ('MASTERCAM', 'TECHNIQUE', 'Fichier Mastercam', 'SOURCE',
   ARRAY['application/octet-stream'], ARRAY['.mcam','.mcx'], 524288000, 1, 120, false),
  ('PROGRAMME_CN', 'TECHNIQUE', 'Programme CN', 'SOURCE',
   ARRAY['text/plain','application/octet-stream'], ARRAY['.nc','.tap','.h','.mpf','.txt'], 52428800, 2, 120, false),
  ('FICHE_REGLAGE', 'TECHNIQUE', 'Fiche de réglage', 'SOURCE',
   ARRAY['application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
   ARRAY['.pdf','.xlsx'], 26214400, 1, 120, false),
  ('MACHINE_MANUEL', 'TECHNIQUE', 'Manuel machine', 'SOURCE',
   ARRAY['application/pdf'], ARRAY['.pdf'], 209715200, 0, 60, false),
  ('PLAN_CONTROLE', 'QUALITE', 'Plan de contrôle', 'SOURCE',
   ARRAY['application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
   ARRAY['.pdf','.xlsx'], 26214400, 2, 120, false),
  ('RELEVE_CONTROLE', 'QUALITE', 'Relevé de contrôle', 'EVIDENCE',
   ARRAY['application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv'],
   ARRAY['.pdf','.xlsx','.csv'], 26214400, 0, 120, true),
  ('NC_CONSTAT', 'QUALITE', 'Constat de non-conformité', 'EVIDENCE',
   ARRAY['application/pdf','image/jpeg','image/png'], ARRAY['.pdf','.jpg','.jpeg','.png'], 52428800, 0, 120, true),
  ('DEROGATION', 'QUALITE', 'Dérogation', 'EVIDENCE',
   ARRAY['application/pdf'], ARRAY['.pdf'], 26214400, 2, 120, true),
  ('CERTIF_ETALONNAGE', 'QUALITE', 'Certificat d''étalonnage', 'EVIDENCE',
   ARRAY['application/pdf'], ARRAY['.pdf'], 26214400, 0, 120, true),
  ('CERTIF_MATIERE', 'ACHATS', 'Certificat matière', 'EVIDENCE',
   ARRAY['application/pdf'], ARRAY['.pdf'], 26214400, 0, 360, true),
  ('FRN_HOMOLOGATION', 'ACHATS', 'Homologation fournisseur', 'EVIDENCE',
   ARRAY['application/pdf'], ARRAY['.pdf'], 26214400, 1, 60, false),
  ('RECEPTION_DOC', 'ACHATS', 'Document de réception', 'EVIDENCE',
   ARRAY['application/pdf','image/jpeg','image/png'], ARRAY['.pdf','.jpg','.jpeg','.png'], 26214400, 0, 120, false),
  ('CONTRAT', 'COMMERCIAL', 'Contrat', 'SOURCE',
   ARRAY['application/pdf'], ARRAY['.pdf'], 52428800, 2, 120, false),
  ('AFFAIRE_DOC', 'COMMERCIAL', 'Document d''affaire', 'SOURCE',
   ARRAY['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
   ARRAY['.pdf','.docx','.xlsx'], 52428800, 0, 120, false),
  ('OF_DOSSIER', 'PRODUCTION', 'Dossier atelier', 'GENERATED',
   ARRAY['application/pdf'], ARRAY['.pdf'], 52428800, 0, 120, false),
  ('OF_PHOTO', 'PRODUCTION', 'Photo / aléa de production', 'EVIDENCE',
   ARRAY['image/jpeg','image/png','image/webp'], ARRAY['.jpg','.jpeg','.png','.webp'], 26214400, 0, 120, false),
  ('DOC_INTERNE', 'GOUVERNANCE', 'Document interne', 'SOURCE',
   ARRAY['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
   ARRAY['.pdf','.docx','.xlsx','.pptx'], 52428800, 0, 60, false),
  ('PROCEDURE', 'GOUVERNANCE', 'Procédure / SMSI', 'SOURCE',
   ARRAY['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
   ARRAY['.pdf','.docx'], 26214400, 2, 120, false)
ON CONFLICT (class_key) DO NOTHING;

/* ------------------------------------------------------------------ */
/* 14) Droits du rôle applicatif                                       */
/* ------------------------------------------------------------------ */

-- Les patches sont appliqués par `postgres`, l'API tourne avec `cerp_app`.
-- PostgreSQL ne propage pas les droits vers les nouvelles tables : sans ce bloc,
-- toute route GED répondrait 500 après migration.
-- Le journal d'accès reste volontairement sans UPDATE ni DELETE : le trigger
-- append-only est une seconde barrière, pas la première.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT ON TABLE public.ged_document_classes TO cerp_app;

    GRANT SELECT, INSERT, UPDATE ON TABLE public.ged_documents TO cerp_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.ged_document_versions TO cerp_app;
    GRANT SELECT, INSERT ON TABLE public.ged_blobs TO cerp_app;
    GRANT SELECT, INSERT, DELETE ON TABLE public.ged_document_links TO cerp_app;
    GRANT SELECT, INSERT, DELETE ON TABLE public.ged_document_relations TO cerp_app;
    GRANT SELECT, INSERT ON TABLE public.ged_approvals TO cerp_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.ged_checkouts TO cerp_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.ged_retention_holds TO cerp_app;
    GRANT SELECT, INSERT ON TABLE public.ged_snapshot_manifests TO cerp_app;
    GRANT SELECT, INSERT ON TABLE public.ged_snapshot_manifest_entries TO cerp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ged_upload_sessions TO cerp_app;

    GRANT SELECT, INSERT ON TABLE public.ged_access_events TO cerp_app;
    GRANT USAGE, SELECT ON SEQUENCE public.ged_access_events_id_seq TO cerp_app;
  END IF;
END
$grants$;

COMMIT;
