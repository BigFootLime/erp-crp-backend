BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE UNIQUE INDEX IF NOT EXISTS of_documents_print_scope_1320_uq ON public.of_documents(id,of_id,revision_id);
CREATE TABLE IF NOT EXISTS public.of_document_print_variants (
  document_id uuid NOT NULL REFERENCES public.of_documents(id) ON DELETE RESTRICT,
  copy_mark text NOT NULL CHECK(copy_mark IN('BROUILLON','DUPLICATA','OBSOLETE')),
  pdf_sha256 text NOT NULL CHECK(pdf_sha256 ~ '^[a-f0-9]{64}$'),
  pdf_byte_size integer NOT NULL CHECK(pdf_byte_size>0 AND pdf_byte_size<=52428800),
  ged_document_id uuid NOT NULL REFERENCES public.ged_documents(id) ON DELETE RESTRICT,
  ged_version_id uuid NOT NULL REFERENCES public.ged_document_versions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(document_id,copy_mark)
);
CREATE TABLE IF NOT EXISTS public.of_document_print_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL,
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  actor_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  document_status text NOT NULL,
  official_ordinal integer NULL,
  copy_mark text NULL,
  copy_sha256 text NOT NULL CHECK(copy_sha256 ~ '^[a-f0-9]{64}$'),
  copy_byte_size integer NOT NULL CHECK(copy_byte_size>0 AND copy_byte_size<=52428800),
  idempotency_key text NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(document_id,of_id,revision_id) REFERENCES public.of_documents(id,of_id,revision_id) ON DELETE RESTRICT,
  CONSTRAINT of_document_print_kind_1320_ck CHECK((
    (document_status='OFFICIEL' AND official_ordinal>0 AND
      ((official_ordinal=1 AND copy_mark IS NULL) OR (official_ordinal>1 AND copy_mark='DUPLICATA')))
    OR (document_status='BROUILLON' AND official_ordinal IS NULL AND copy_mark='BROUILLON')
    OR (document_status='OBSOLETE' AND official_ordinal IS NULL AND copy_mark='OBSOLETE')) IS TRUE)
);
CREATE UNIQUE INDEX IF NOT EXISTS of_document_print_ordinal_1320_uq
  ON public.of_document_print_intents(of_id,revision_id,official_ordinal) WHERE official_ordinal IS NOT NULL;
CREATE INDEX IF NOT EXISTS of_document_print_document_1320_idx ON public.of_document_print_intents(document_id,created_at);

CREATE OR REPLACE FUNCTION public.fn_of_print_evidence_immutable_1320() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'OF print evidence is immutable' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS trg_of_print_intents_immutable_1320 ON public.of_document_print_intents;
CREATE TRIGGER trg_of_print_intents_immutable_1320 BEFORE UPDATE OR DELETE ON public.of_document_print_intents
  FOR EACH ROW EXECUTE FUNCTION public.fn_of_print_evidence_immutable_1320();
DROP TRIGGER IF EXISTS trg_of_print_variants_immutable_1320 ON public.of_document_print_variants;
CREATE TRIGGER trg_of_print_variants_immutable_1320 BEFORE UPDATE OR DELETE ON public.of_document_print_variants
  FOR EACH ROW EXECUTE FUNCTION public.fn_of_print_evidence_immutable_1320();

CREATE OR REPLACE FUNCTION public.fn_of_print_intent_scope_1320() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE saved public.of_documents%ROWTYPE; previous integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('of_revision:' || NEW.of_id));
  SELECT * INTO saved FROM public.of_documents WHERE id=NEW.document_id AND of_id=NEW.of_id AND revision_id=NEW.revision_id;
  IF NOT FOUND OR saved.statut IS DISTINCT FROM NEW.document_status THEN
    RAISE EXCEPTION 'OF print document scope changed' USING ERRCODE='23514';
  END IF;
  IF NEW.document_status='OFFICIEL' THEN
    SELECT COALESCE(MAX(official_ordinal),0) INTO previous FROM public.of_document_print_intents
      WHERE of_id=NEW.of_id AND revision_id=NEW.revision_id;
    IF NEW.official_ordinal IS DISTINCT FROM previous+1 THEN
      RAISE EXCEPTION 'OF print ordinal must be consecutive' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.copy_mark IS NULL OR NEW.copy_mark IS NOT DISTINCT FROM saved.payload->>'watermark' THEN
    IF NEW.copy_sha256 IS DISTINCT FROM saved.pdf_sha256 OR NEW.copy_byte_size IS DISTINCT FROM saved.pdf_byte_size THEN
      RAISE EXCEPTION 'OF print original identity changed' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.of_document_print_variants WHERE document_id=NEW.document_id AND copy_mark=NEW.copy_mark
      AND pdf_sha256=NEW.copy_sha256 AND pdf_byte_size=NEW.copy_byte_size) THEN
      RAISE EXCEPTION 'OF print variant must be archived first' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_of_print_intent_scope_1320 ON public.of_document_print_intents;
CREATE TRIGGER trg_of_print_intent_scope_1320 BEFORE INSERT ON public.of_document_print_intents
  FOR EACH ROW EXECUTE FUNCTION public.fn_of_print_intent_scope_1320();
COMMENT ON TABLE public.of_document_print_intents IS 'Accepted print requests, not confirmed physical output. Downloads/previews and historical reprint_count do not allocate an ordinal.';
COMMENT ON TABLE public.of_document_print_variants IS 'Immutable derivative copies in separate GED documents; the original OF archive is never replaced.';
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
    GRANT SELECT,INSERT ON public.of_document_print_intents,public.of_document_print_variants TO cerp_app;
  END IF;
END $$;
COMMIT;
