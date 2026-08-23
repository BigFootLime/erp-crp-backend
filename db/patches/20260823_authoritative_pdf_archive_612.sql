-- #612 — Archivage autoritatif des PDF sortants dans la GED.
--
-- Additif et reversible : ce patch ne rebascule aucun producteur existant.
-- Il fournit le contrat commun utilise par les commandes, fiches, OF et pieces
-- techniques : un instantane fige, un PDF adresse par empreinte et une file
-- transactionnelle pour le versement GED apres la creation de l'entite.

BEGIN;

-- This one-shot migration owns the class it creates. Refuse any existing key
-- rather than silently adopting operator configuration that rollback could
-- later delete.
DO $$
BEGIN
  IF to_regclass('public.ged_document_classes') IS NULL
     OR to_regclass('public.ged_documents') IS NULL
     OR to_regclass('public.ged_document_versions') IS NULL
     OR to_regclass('public.ged_document_links') IS NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_PREREQUISITE_MISSING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_APP_ROLE_MISSING';
  END IF;
  IF to_regprocedure('gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_UUID_GENERATOR_MISSING';
  END IF;

  IF EXISTS (SELECT 1 FROM public.ged_document_classes WHERE class_key IN ('CERP_AUTHORITATIVE_PDF', 'CERP_SYSTEM_SNAPSHOT')) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_CLASS_ALREADY_EXISTS';
  END IF;

  IF to_regclass('public.authoritative_pdf_archives') IS NOT NULL
     OR to_regclass('public.authoritative_pdf_archive_outbox') IS NOT NULL
     OR to_regclass('public.authoritative_pdf_archive_snapshot_lookup_idx') IS NOT NULL
     OR to_regclass('public.authoritative_pdf_archive_outbox_ready_idx') IS NOT NULL
     OR to_regclass('public.authoritative_pdf_archive_outbox_stale_idx') IS NOT NULL
     OR to_regprocedure('public.fn_authoritative_pdf_archive_immutable_612()') IS NOT NULL
     OR to_regprocedure('public.fn_authoritative_pdf_archive_outbox_stamp_612()') IS NOT NULL
     OR to_regprocedure('public.fn_authoritative_pdf_archive_outbox_complete_612()') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname IN ('trg_authoritative_pdf_archive_immutable_612', 'trg_authoritative_pdf_archive_outbox_stamp_612', 'trg_authoritative_pdf_archive_outbox_complete_612')
     ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_TARGET_NAMESPACE_ALREADY_EXISTS';
  END IF;
END;
$$;

INSERT INTO public.ged_document_classes
  (class_key, domain, label, nature, allowed_mime_types, allowed_extensions,
   max_size_bytes, approvals_required, retention_months, hold_on_publish, is_active)
VALUES
  ('CERP_AUTHORITATIVE_PDF', 'CERP', 'PDF sortant autoritatif', 'GENERATED',
   ARRAY['application/pdf'], ARRAY['pdf'], 52428800, 0, 120, false, true),
  ('CERP_SYSTEM_SNAPSHOT', 'CERP', 'Instantané interne de création', 'GENERATED',
   ARRAY['application/pdf'], ARRAY['pdf'], 52428800, 0, 120, false, true);

CREATE TABLE public.authoritative_pdf_archives (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type        text NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_-]{1,63}$'),
  entity_id          text NOT NULL CHECK (length(btrim(entity_id)) BETWEEN 1 AND 160),
  document_kind      text NOT NULL CHECK (document_kind ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  document_version   integer NOT NULL CHECK (document_version >= 1),
  render_version     text NOT NULL CHECK (length(btrim(render_version)) BETWEEN 1 AND 64),
  idempotency_key    text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 240),
  title              text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  original_name      text NOT NULL CHECK (original_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.pdf$'),
  source_snapshot    jsonb NOT NULL,
  source_revision    text NOT NULL CHECK (length(btrim(source_revision)) BETWEEN 1 AND 160),
  snapshot_sha256    text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  pdf_sha256         text NULL CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[a-f0-9]{64}$'),
  pdf_size_bytes     bigint NULL,
  ged_document_id    uuid NULL REFERENCES public.ged_documents(id) ON DELETE RESTRICT,
  ged_version_id     uuid NULL REFERENCES public.ged_document_versions(id) ON DELETE RESTRICT,
  archived_at        timestamptz NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT authoritative_pdf_archive_document_version_uq
    UNIQUE (entity_type, entity_id, document_kind, document_version),
  CONSTRAINT authoritative_pdf_archive_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT authoritative_pdf_archive_pdf_size_ck CHECK (
    pdf_size_bytes IS NULL OR (pdf_size_bytes > 0 AND pdf_size_bytes <= 52428800)
  ),
  CONSTRAINT authoritative_pdf_archive_complete_ck CHECK (
    (archived_at IS NULL AND pdf_sha256 IS NULL AND pdf_size_bytes IS NULL AND ged_document_id IS NULL AND ged_version_id IS NULL)
    OR
    (archived_at IS NOT NULL AND pdf_sha256 IS NOT NULL AND pdf_size_bytes IS NOT NULL AND ged_document_id IS NOT NULL AND ged_version_id IS NOT NULL)
  )
);

-- A deliberate reissue can preserve exactly the same business snapshot while
-- creating a new, human-visible edition.  The snapshot is immutable per row,
-- but must not be a uniqueness key across editions.
CREATE INDEX authoritative_pdf_archive_snapshot_lookup_idx
  ON public.authoritative_pdf_archives(entity_type, entity_id, document_kind, snapshot_sha256);

COMMENT ON TABLE public.authoritative_pdf_archives IS
  'Registre immuable des PDF sortants : instantane source, edition et empreinte; inclut les instantanes internes de creation.';

CREATE TABLE public.authoritative_pdf_archive_outbox (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  archive_id         uuid NOT NULL REFERENCES public.authoritative_pdf_archives(id) ON DELETE RESTRICT,
  event_key          text NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'PROCESSING', 'ARCHIVED', 'FAILED')),
  attempt_count      integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at       timestamptz NOT NULL DEFAULT now(),
  locked_at          timestamptz NULL,
  locked_by          text NULL,
  claim_token        uuid NULL,
  archived_at        timestamptz NULL,
  last_error         text NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT authoritative_pdf_archive_outbox_archive_uq UNIQUE (archive_id),
  CONSTRAINT authoritative_pdf_archive_outbox_lifecycle_ck CHECK (
    (status = 'ARCHIVED') = (archived_at IS NOT NULL)
    AND (
      (status = 'PROCESSING' AND locked_at IS NOT NULL AND locked_by IS NOT NULL AND length(btrim(locked_by)) > 0 AND claim_token IS NOT NULL)
      OR (status <> 'PROCESSING' AND locked_at IS NULL AND locked_by IS NULL AND claim_token IS NULL)
    )
  )
);

CREATE INDEX authoritative_pdf_archive_outbox_ready_idx
  ON public.authoritative_pdf_archive_outbox(status, available_at, created_at)
  WHERE status IN ('PENDING', 'FAILED');

-- A worker lease is deliberately finite. A process crash must never strand a
-- creation snapshot forever; a later worker may safely reclaim it because the
-- archive registry and its GED links are idempotent.
CREATE INDEX authoritative_pdf_archive_outbox_stale_idx
  ON public.authoritative_pdf_archive_outbox(locked_at)
  WHERE status = 'PROCESSING';

CREATE FUNCTION public.fn_authoritative_pdf_archive_immutable_612()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.entity_type IS DISTINCT FROM OLD.entity_type
     OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.document_kind IS DISTINCT FROM OLD.document_kind
     OR NEW.document_version IS DISTINCT FROM OLD.document_version
     OR NEW.render_version IS DISTINCT FROM OLD.render_version
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.original_name IS DISTINCT FROM OLD.original_name
     OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
     OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
     OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_ARCHIVE_IMMUTABLE: archive source identity cannot change (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.archived_at IS NOT NULL AND (
       NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256
       OR NEW.pdf_size_bytes IS DISTINCT FROM OLD.pdf_size_bytes
       OR NEW.ged_document_id IS DISTINCT FROM OLD.ged_document_id
       OR NEW.ged_version_id IS DISTINCT FROM OLD.ged_version_id
       OR NEW.archived_at IS DISTINCT FROM OLD.archived_at) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_ARCHIVE_IMMUTABLE: archived bytes cannot change (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_authoritative_pdf_archive_immutable_612
  BEFORE UPDATE ON public.authoritative_pdf_archives
  FOR EACH ROW EXECUTE FUNCTION public.fn_authoritative_pdf_archive_immutable_612();

CREATE FUNCTION public.fn_authoritative_pdf_archive_outbox_stamp_612()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
CREATE TRIGGER trg_authoritative_pdf_archive_outbox_stamp_612
  BEFORE UPDATE ON public.authoritative_pdf_archive_outbox
  FOR EACH ROW EXECUTE FUNCTION public.fn_authoritative_pdf_archive_outbox_stamp_612();

-- An outbox row may become ARCHIVED only after the matching immutable archive
-- has all exact-byte/GED evidence. This cross-table guard complements the
-- local lifecycle CHECK and matches the worker's archive-then-outbox order.
CREATE FUNCTION public.fn_authoritative_pdf_archive_outbox_complete_612()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'ARCHIVED' AND NOT EXISTS (
    SELECT 1
      FROM public.authoritative_pdf_archives a
     WHERE a.id = NEW.archive_id
       AND a.archived_at IS NOT NULL
       AND a.pdf_sha256 IS NOT NULL
       AND a.pdf_size_bytes IS NOT NULL
       AND a.ged_document_id IS NOT NULL
       AND a.ged_version_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_OUTBOX_ARCHIVED_WITHOUT_COMPLETE_ARCHIVE'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_authoritative_pdf_archive_outbox_complete_612
  BEFORE INSERT OR UPDATE OF status, archive_id ON public.authoritative_pdf_archive_outbox
  FOR EACH ROW EXECUTE FUNCTION public.fn_authoritative_pdf_archive_outbox_complete_612();

GRANT SELECT, INSERT, UPDATE ON TABLE public.authoritative_pdf_archives TO cerp_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.authoritative_pdf_archive_outbox TO cerp_app;

COMMIT;
