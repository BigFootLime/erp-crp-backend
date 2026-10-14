BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE TABLE IF NOT EXISTS public.of_workshop_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL,
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  document_status text NOT NULL CHECK(document_status IN('BROUILLON','OFFICIEL','OBSOLETE')),
  source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
  source_manifest jsonb NOT NULL CHECK(jsonb_typeof(source_manifest)='array' AND jsonb_array_length(source_manifest) BETWEEN 1 AND 40),
  preparation_kind text NULL CHECK(preparation_kind IN('PREPARATION_CREATION','PREPARATION_INDEX')),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  FOREIGN KEY(document_id,of_id,revision_id) REFERENCES public.of_documents(id,of_id,revision_id) ON DELETE RESTRICT,
  UNIQUE(document_id,source_fingerprint)
);
CREATE TABLE IF NOT EXISTS public.of_workshop_folder_copies (
  folder_id uuid NOT NULL REFERENCES public.of_workshop_folders(id) ON DELETE RESTRICT,
  copy_mark text NOT NULL CHECK(copy_mark IN('ORIGINAL','BROUILLON','DUPLICATA','OBSOLETE')),
  pdf_sha256 text NOT NULL CHECK(pdf_sha256 ~ '^[a-f0-9]{64}$'),
  pdf_byte_size integer NOT NULL CHECK(pdf_byte_size>0 AND pdf_byte_size<=52428800),
  page_count integer NOT NULL CHECK(page_count BETWEEN 1 AND 200),
  page_manifest jsonb NOT NULL CHECK(jsonb_typeof(page_manifest)='array'),
  ged_document_id uuid NOT NULL REFERENCES public.ged_documents(id) ON DELETE RESTRICT,
  ged_version_id uuid NOT NULL REFERENCES public.ged_document_versions(id) ON DELETE RESTRICT,
  PRIMARY KEY(folder_id,copy_mark)
);
CREATE TABLE IF NOT EXISTS public.of_workshop_folder_prints (
  intent_id uuid PRIMARY KEY REFERENCES public.of_document_print_intents(id) ON DELETE RESTRICT,
  folder_id uuid NOT NULL,
  copy_mark text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(folder_id,copy_mark) REFERENCES public.of_workshop_folder_copies(folder_id,copy_mark) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS public.of_workshop_folder_preparations (
  idempotency_key text PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  folder_id uuid NOT NULL REFERENCES public.of_workshop_folders(id) ON DELETE RESTRICT,
  actor_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION public.fn_of_workshop_folder_print_scope_1320() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.of_document_print_intents intent JOIN public.of_workshop_folders folder
    ON folder.of_id=intent.of_id AND folder.document_id=intent.document_id AND folder.revision_id=intent.revision_id
      AND folder.document_status=intent.document_status
    WHERE intent.id=NEW.intent_id AND folder.id=NEW.folder_id AND COALESCE(intent.copy_mark,'ORIGINAL')=NEW.copy_mark) THEN
    RAISE EXCEPTION 'Workshop folder print scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_of_workshop_folder_print_scope_1320 ON public.of_workshop_folder_prints;
CREATE TRIGGER trg_of_workshop_folder_print_scope_1320 BEFORE INSERT ON public.of_workshop_folder_prints
  FOR EACH ROW EXECUTE FUNCTION public.fn_of_workshop_folder_print_scope_1320();
DO $$ DECLARE object text; BEGIN
  FOREACH object IN ARRAY ARRAY['of_workshop_folders','of_workshop_folder_copies','of_workshop_folder_prints','of_workshop_folder_preparations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_workshop_folder_immutable_1320 ON public.%I',object);
    EXECUTE format('CREATE TRIGGER trg_workshop_folder_immutable_1320 BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_of_print_evidence_immutable_1320()',object);
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM cerp_app',object);
      EXECUTE format('GRANT SELECT,INSERT ON public.%I TO cerp_app',object);
    END IF;
  END LOOP;
END $$;
COMMENT ON TABLE public.of_workshop_folders IS 'Pinned workshop annex editions. Plan moves and print retries do not rewrite an edition.';
COMMENT ON TABLE public.of_workshop_folder_prints IS 'The complete archived packet chosen atomically with its OF print intent and ordinal.';
COMMIT;
