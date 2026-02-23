-- Livraisons persistence (bon_livraison*) using UUID PKs.
-- Idempotent patch: safe to run multiple times.

BEGIN;

-- Human-readable BL numbering.
CREATE SEQUENCE IF NOT EXISTS public.bon_livraison_no_seq;

CREATE TABLE IF NOT EXISTS public.bon_livraison (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero TEXT NOT NULL,
  statut TEXT NOT NULL DEFAULT 'DRAFT',
  client_id CHARACTER VARYING NOT NULL,
  commande_id BIGINT NULL,
  affaire_id BIGINT NULL,
  adresse_livraison_id UUID NULL,
  date_creation DATE NOT NULL DEFAULT CURRENT_DATE,
  date_expedition DATE NULL,
  date_livraison DATE NULL,
  transporteur TEXT NULL,
  tracking_number TEXT NULL,
  commentaire_interne TEXT NULL,
  commentaire_client TEXT NULL,
  reception_nom_signataire TEXT NULL,
  reception_date_signature TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

-- Uniqueness on displayed number.
CREATE UNIQUE INDEX IF NOT EXISTS bon_livraison_numero_key ON public.bon_livraison (numero);
CREATE INDEX IF NOT EXISTS bon_livraison_client_idx ON public.bon_livraison (client_id);
CREATE INDEX IF NOT EXISTS bon_livraison_commande_idx ON public.bon_livraison (commande_id);
CREATE INDEX IF NOT EXISTS bon_livraison_affaire_idx ON public.bon_livraison (affaire_id);
CREATE INDEX IF NOT EXISTS bon_livraison_updated_at_idx ON public.bon_livraison (updated_at);
CREATE INDEX IF NOT EXISTS bon_livraison_date_creation_idx ON public.bon_livraison (date_creation);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_statut_check'
      AND conrelid = 'public.bon_livraison'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison
      ADD CONSTRAINT bon_livraison_statut_check
      CHECK (statut IN ('DRAFT','READY','SHIPPED','DELIVERED','CANCELLED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_client_id_fkey'
      AND conrelid = 'public.bon_livraison'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison
      ADD CONSTRAINT bon_livraison_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_commande_id_fkey'
      AND conrelid = 'public.bon_livraison'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison
      ADD CONSTRAINT bon_livraison_commande_id_fkey
      FOREIGN KEY (commande_id) REFERENCES public.commande_client(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_affaire_id_fkey'
      AND conrelid = 'public.bon_livraison'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison
      ADD CONSTRAINT bon_livraison_affaire_id_fkey
      FOREIGN KEY (affaire_id) REFERENCES public.affaire(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_adresse_livraison_id_fkey'
      AND conrelid = 'public.bon_livraison'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison
      ADD CONSTRAINT bon_livraison_adresse_livraison_id_fkey
      FOREIGN KEY (adresse_livraison_id) REFERENCES public.adresse_livraison(delivery_address_id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_created_by_fkey'
      AND conrelid = 'public.bon_livraison'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison
      ADD CONSTRAINT bon_livraison_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_updated_by_fkey'
      AND conrelid = 'public.bon_livraison'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison
      ADD CONSTRAINT bon_livraison_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.bon_livraison_ligne (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bon_livraison_id UUID NOT NULL,
  ordre INTEGER NOT NULL,
  designation TEXT NOT NULL,
  code_piece TEXT NULL,
  quantite NUMERIC(12, 3) NOT NULL,
  unite TEXT NULL,
  commande_ligne_id BIGINT NULL,
  delai_client DATE NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS bon_livraison_ligne_unique_ordre ON public.bon_livraison_ligne (bon_livraison_id, ordre);
CREATE INDEX IF NOT EXISTS bon_livraison_ligne_bl_idx ON public.bon_livraison_ligne (bon_livraison_id);
CREATE INDEX IF NOT EXISTS bon_livraison_ligne_commande_ligne_idx ON public.bon_livraison_ligne (commande_ligne_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_ligne_bl_fkey'
      AND conrelid = 'public.bon_livraison_ligne'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne
      ADD CONSTRAINT bon_livraison_ligne_bl_fkey
      FOREIGN KEY (bon_livraison_id) REFERENCES public.bon_livraison(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_ligne_commande_ligne_id_fkey'
      AND conrelid = 'public.bon_livraison_ligne'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne
      ADD CONSTRAINT bon_livraison_ligne_commande_ligne_id_fkey
      FOREIGN KEY (commande_ligne_id) REFERENCES public.commande_ligne(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_ligne_qty_check'
      AND conrelid = 'public.bon_livraison_ligne'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne
      ADD CONSTRAINT bon_livraison_ligne_qty_check
      CHECK (quantite > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_ligne_created_by_fkey'
      AND conrelid = 'public.bon_livraison_ligne'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne
      ADD CONSTRAINT bon_livraison_ligne_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_ligne_updated_by_fkey'
      AND conrelid = 'public.bon_livraison_ligne'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne
      ADD CONSTRAINT bon_livraison_ligne_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.bon_livraison_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bon_livraison_id UUID NOT NULL,
  document_id UUID NOT NULL,
  type TEXT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  uploaded_by INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bon_livraison_documents_unique_doc ON public.bon_livraison_documents (bon_livraison_id, document_id);
CREATE INDEX IF NOT EXISTS bon_livraison_documents_bl_idx ON public.bon_livraison_documents (bon_livraison_id);
CREATE INDEX IF NOT EXISTS bon_livraison_documents_created_at_idx ON public.bon_livraison_documents (created_at);
CREATE INDEX IF NOT EXISTS bon_livraison_documents_type_idx ON public.bon_livraison_documents (type);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_documents_bl_fkey'
      AND conrelid = 'public.bon_livraison_documents'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_documents
      ADD CONSTRAINT bon_livraison_documents_bl_fkey
      FOREIGN KEY (bon_livraison_id) REFERENCES public.bon_livraison(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_documents_document_fkey'
      AND conrelid = 'public.bon_livraison_documents'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_documents
      ADD CONSTRAINT bon_livraison_documents_document_fkey
      FOREIGN KEY (document_id) REFERENCES public.documents_clients(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_documents_uploaded_by_fkey'
      AND conrelid = 'public.bon_livraison_documents'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_documents
      ADD CONSTRAINT bon_livraison_documents_uploaded_by_fkey
      FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.bon_livraison_event_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bon_livraison_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  old_values JSONB NULL,
  new_values JSONB NULL,
  user_id INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bon_livraison_event_log_bl_idx ON public.bon_livraison_event_log (bon_livraison_id);
CREATE INDEX IF NOT EXISTS bon_livraison_event_log_created_at_idx ON public.bon_livraison_event_log (created_at);
CREATE INDEX IF NOT EXISTS bon_livraison_event_log_event_type_idx ON public.bon_livraison_event_log (event_type);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_event_log_bl_fkey'
      AND conrelid = 'public.bon_livraison_event_log'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_event_log
      ADD CONSTRAINT bon_livraison_event_log_bl_fkey
      FOREIGN KEY (bon_livraison_id) REFERENCES public.bon_livraison(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_event_log_user_fkey'
      AND conrelid = 'public.bon_livraison_event_log'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_event_log
      ADD CONSTRAINT bon_livraison_event_log_user_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMIT;
