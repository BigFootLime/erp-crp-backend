-- 20260225_fournisseurs_catalogue.sql
-- Fournisseurs module (master data + contacts + catalogue + documents)
-- Idempotent patch: safe to run multiple times.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Optional extensions                                                     */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  -- Commonly used for gen_random_uuid(). If already installed, this is a no-op.
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping extension pgcrypto (insufficient_privilege)';
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Master: fournisseurs                                                    */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.fournisseurs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  nom text NOT NULL,
  actif boolean NOT NULL DEFAULT true,
  tva text NULL,
  siret text NULL,
  email text NULL,
  telephone text NULL,
  site_web text NULL,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  updated_by integer NULL
);

-- Ensure expected columns exist even if a legacy table already exists.
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS nom text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS actif boolean;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS tva text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS siret text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS telephone text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS site_web text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS created_by integer;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS updated_by integer;

CREATE UNIQUE INDEX IF NOT EXISTS fournisseurs_code_uniq ON public.fournisseurs (code);
CREATE INDEX IF NOT EXISTS fournisseurs_nom_idx ON public.fournisseurs (nom);
CREATE INDEX IF NOT EXISTS fournisseurs_actif_idx ON public.fournisseurs (actif);
CREATE INDEX IF NOT EXISTS fournisseurs_updated_at_idx ON public.fournisseurs (updated_at);

DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseurs_created_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseurs
      ADD CONSTRAINT fournisseurs_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseurs_updated_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseurs
      ADD CONSTRAINT fournisseurs_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2) Contacts                                                                */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.fournisseur_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fournisseur_id uuid NOT NULL,
  nom text NOT NULL,
  email text NULL,
  telephone text NULL,
  role text NULL,
  notes text NULL,
  actif boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  updated_by integer NULL
);

CREATE INDEX IF NOT EXISTS fournisseur_contacts_fournisseur_idx ON public.fournisseur_contacts (fournisseur_id);
CREATE INDEX IF NOT EXISTS fournisseur_contacts_actif_idx ON public.fournisseur_contacts (actif);
CREATE INDEX IF NOT EXISTS fournisseur_contacts_updated_at_idx ON public.fournisseur_contacts (updated_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_contacts_fournisseur_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_contacts
      ADD CONSTRAINT fournisseur_contacts_fournisseur_fkey
      FOREIGN KEY (fournisseur_id) REFERENCES public.fournisseurs(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_contacts_created_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_contacts
      ADD CONSTRAINT fournisseur_contacts_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_contacts_updated_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_contacts
      ADD CONSTRAINT fournisseur_contacts_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 3) Catalogue (what the supplier provides)                                  */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.fournisseur_catalogue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fournisseur_id uuid NOT NULL,
  type text NOT NULL,
  article_id uuid NULL,
  designation text NOT NULL,
  reference_fournisseur text NULL,
  unite text NULL,
  prix_unitaire numeric(12, 3) NULL,
  devise text NULL DEFAULT 'EUR',
  delai_jours integer NULL,
  moq numeric(12, 3) NULL,
  conditions text NULL,
  actif boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  updated_by integer NULL
);

CREATE INDEX IF NOT EXISTS fournisseur_catalogue_fournisseur_idx ON public.fournisseur_catalogue (fournisseur_id);
CREATE INDEX IF NOT EXISTS fournisseur_catalogue_type_idx ON public.fournisseur_catalogue (type);
CREATE INDEX IF NOT EXISTS fournisseur_catalogue_article_idx ON public.fournisseur_catalogue (article_id);
CREATE INDEX IF NOT EXISTS fournisseur_catalogue_actif_idx ON public.fournisseur_catalogue (actif);
CREATE INDEX IF NOT EXISTS fournisseur_catalogue_updated_at_idx ON public.fournisseur_catalogue (updated_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_catalogue_fournisseur_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_catalogue
      ADD CONSTRAINT fournisseur_catalogue_fournisseur_fkey
      FOREIGN KEY (fournisseur_id) REFERENCES public.fournisseurs(id) ON DELETE CASCADE;
  END IF;

  -- Optional link to stock articles (only if the column type is UUID).
  IF to_regclass('public.articles') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'articles'
      AND column_name = 'id'
      AND data_type = 'uuid'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_catalogue_article_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_catalogue
      ADD CONSTRAINT fournisseur_catalogue_article_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_catalogue_type_check'
  ) THEN
    ALTER TABLE public.fournisseur_catalogue
      ADD CONSTRAINT fournisseur_catalogue_type_check
      CHECK (type IN ('MATIERE','CONSOMMABLE','SOUS_TRAITANCE','SERVICE','OUTILLAGE','AUTRE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_catalogue_nonneg_chk'
  ) THEN
    ALTER TABLE public.fournisseur_catalogue
      ADD CONSTRAINT fournisseur_catalogue_nonneg_chk
      CHECK (
        (prix_unitaire IS NULL OR prix_unitaire >= 0)
        AND (moq IS NULL OR moq >= 0)
        AND (delai_jours IS NULL OR delai_jours >= 0)
      );
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_catalogue_created_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_catalogue
      ADD CONSTRAINT fournisseur_catalogue_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_catalogue_updated_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_catalogue
      ADD CONSTRAINT fournisseur_catalogue_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 4) Documents                                                               */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.fournisseur_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fournisseur_id uuid NOT NULL,
  document_type text NOT NULL,
  commentaire text NULL,
  original_name text NOT NULL,
  stored_name text NOT NULL,
  storage_path text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NULL,
  label text NULL,
  uploaded_by integer NULL,
  removed_at timestamptz NULL,
  removed_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  updated_by integer NULL,
  CONSTRAINT fournisseur_documents_size_nonneg_chk CHECK (size_bytes >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS fournisseur_documents_storage_path_uniq ON public.fournisseur_documents (storage_path);
CREATE INDEX IF NOT EXISTS fournisseur_documents_fournisseur_idx ON public.fournisseur_documents (fournisseur_id);
CREATE INDEX IF NOT EXISTS fournisseur_documents_fournisseur_active_idx ON public.fournisseur_documents (fournisseur_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS fournisseur_documents_type_idx ON public.fournisseur_documents (document_type);
CREATE INDEX IF NOT EXISTS fournisseur_documents_created_at_idx ON public.fournisseur_documents (created_at);
CREATE INDEX IF NOT EXISTS fournisseur_documents_removed_at_idx ON public.fournisseur_documents (removed_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_documents_fournisseur_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_documents
      ADD CONSTRAINT fournisseur_documents_fournisseur_fkey
      FOREIGN KEY (fournisseur_id) REFERENCES public.fournisseurs(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_documents_uploaded_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_documents
      ADD CONSTRAINT fournisseur_documents_uploaded_by_fkey
      FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_documents_removed_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_documents
      ADD CONSTRAINT fournisseur_documents_removed_by_fkey
      FOREIGN KEY (removed_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_documents_created_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_documents
      ADD CONSTRAINT fournisseur_documents_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_documents_updated_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_documents
      ADD CONSTRAINT fournisseur_documents_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 5) updated_at triggers (optional)                                           */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regproc('public.tg_set_updated_at()') IS NULL THEN
    RAISE NOTICE 'tg_set_updated_at() not found; skipping updated_at triggers.';
    RETURN;
  END IF;

  EXECUTE 'DROP TRIGGER IF EXISTS fournisseurs_set_updated_at ON public.fournisseurs';
  EXECUTE 'CREATE TRIGGER fournisseurs_set_updated_at BEFORE UPDATE ON public.fournisseurs FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS fournisseur_contacts_set_updated_at ON public.fournisseur_contacts';
  EXECUTE 'CREATE TRIGGER fournisseur_contacts_set_updated_at BEFORE UPDATE ON public.fournisseur_contacts FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS fournisseur_catalogue_set_updated_at ON public.fournisseur_catalogue';
  EXECUTE 'CREATE TRIGGER fournisseur_catalogue_set_updated_at BEFORE UPDATE ON public.fournisseur_catalogue FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS fournisseur_documents_set_updated_at ON public.fournisseur_documents';
  EXECUTE 'CREATE TRIGGER fournisseur_documents_set_updated_at BEFORE UPDATE ON public.fournisseur_documents FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
END $$;

COMMIT;
