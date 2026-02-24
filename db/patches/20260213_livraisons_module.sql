-- 20260213_livraisons_module.sql
-- Livraisons module (Bons de livraison + suivi)
-- Idempotent: safe to re-run.

BEGIN;

-- UUID helpers (used by existing schema; safe to ensure)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- bon_livraison
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bon_livraison (
  id BIGSERIAL PRIMARY KEY,
  numero VARCHAR(30) NOT NULL,

  client_id TEXT NOT NULL,
  commande_id INTEGER NULL,
  affaire_id INTEGER NULL,
  adresse_livraison_id UUID NULL,

  statut TEXT NOT NULL DEFAULT 'DRAFT',

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

-- Constraints (idempotent via catalogs)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_numero_key'
  ) THEN
    ALTER TABLE bon_livraison
      ADD CONSTRAINT bon_livraison_numero_key UNIQUE (numero);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_statut_check'
  ) THEN
    ALTER TABLE bon_livraison
      ADD CONSTRAINT bon_livraison_statut_check
      CHECK (statut IN ('DRAFT', 'READY', 'SHIPPED', 'DELIVERED', 'CANCELLED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_client_id_fkey'
  ) THEN
    ALTER TABLE bon_livraison
      ADD CONSTRAINT bon_livraison_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES clients(client_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_commande_id_fkey'
  ) THEN
    ALTER TABLE bon_livraison
      ADD CONSTRAINT bon_livraison_commande_id_fkey
      FOREIGN KEY (commande_id) REFERENCES commande_client(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_affaire_id_fkey'
  ) THEN
    ALTER TABLE bon_livraison
      ADD CONSTRAINT bon_livraison_affaire_id_fkey
      FOREIGN KEY (affaire_id) REFERENCES affaire(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_adresse_livraison_id_fkey'
  ) THEN
    ALTER TABLE bon_livraison
      ADD CONSTRAINT bon_livraison_adresse_livraison_id_fkey
      FOREIGN KEY (adresse_livraison_id) REFERENCES adresse_livraison(delivery_address_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_created_by_fkey'
  ) THEN
    ALTER TABLE bon_livraison
      ADD CONSTRAINT bon_livraison_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_updated_by_fkey'
  ) THEN
    ALTER TABLE bon_livraison
      ADD CONSTRAINT bon_livraison_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES users(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bon_livraison_client_id_idx ON bon_livraison(client_id);
CREATE INDEX IF NOT EXISTS bon_livraison_commande_id_idx ON bon_livraison(commande_id);
CREATE INDEX IF NOT EXISTS bon_livraison_affaire_id_idx ON bon_livraison(affaire_id);
CREATE INDEX IF NOT EXISTS bon_livraison_statut_idx ON bon_livraison(statut);
CREATE INDEX IF NOT EXISTS bon_livraison_date_creation_idx ON bon_livraison(date_creation);
CREATE INDEX IF NOT EXISTS bon_livraison_updated_at_idx ON bon_livraison(updated_at);

-- -----------------------------------------------------------------------------
-- bon_livraison_ligne
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bon_livraison_ligne (
  id BIGSERIAL PRIMARY KEY,
  bon_livraison_id BIGINT NOT NULL,
  ordre INTEGER NOT NULL DEFAULT 1,

  designation TEXT NOT NULL,
  code_piece TEXT NULL,
  quantite NUMERIC(18, 3) NOT NULL,
  unite TEXT NULL,
  commande_ligne_id INTEGER NULL,
  delai_client TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_ligne_bon_livraison_id_fkey'
  ) THEN
    ALTER TABLE bon_livraison_ligne
      ADD CONSTRAINT bon_livraison_ligne_bon_livraison_id_fkey
      FOREIGN KEY (bon_livraison_id) REFERENCES bon_livraison(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_ligne_commande_ligne_id_fkey'
  ) THEN
    ALTER TABLE bon_livraison_ligne
      ADD CONSTRAINT bon_livraison_ligne_commande_ligne_id_fkey
      FOREIGN KEY (commande_ligne_id) REFERENCES commande_ligne(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_ligne_quantite_check'
  ) THEN
    ALTER TABLE bon_livraison_ligne
      ADD CONSTRAINT bon_livraison_ligne_quantite_check
      CHECK (quantite > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_ligne_created_by_fkey'
  ) THEN
    ALTER TABLE bon_livraison_ligne
      ADD CONSTRAINT bon_livraison_ligne_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_ligne_updated_by_fkey'
  ) THEN
    ALTER TABLE bon_livraison_ligne
      ADD CONSTRAINT bon_livraison_ligne_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES users(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bon_livraison_ligne_bl_id_idx ON bon_livraison_ligne(bon_livraison_id);
CREATE INDEX IF NOT EXISTS bon_livraison_ligne_commande_ligne_id_idx ON bon_livraison_ligne(commande_ligne_id);
CREATE INDEX IF NOT EXISTS bon_livraison_ligne_ordre_idx ON bon_livraison_ligne(bon_livraison_id, ordre);

-- -----------------------------------------------------------------------------
-- bon_livraison_documents
-- Links bon_livraison -> documents_clients (same pattern as facture_documents, etc.)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bon_livraison_documents (
  id BIGSERIAL PRIMARY KEY,
  bon_livraison_id BIGINT NOT NULL,
  document_id UUID NOT NULL,
  type TEXT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  uploaded_by INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_documents_bl_id_fkey'
  ) THEN
    ALTER TABLE bon_livraison_documents
      ADD CONSTRAINT bon_livraison_documents_bl_id_fkey
      FOREIGN KEY (bon_livraison_id) REFERENCES bon_livraison(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_documents_document_id_fkey'
  ) THEN
    ALTER TABLE bon_livraison_documents
      ADD CONSTRAINT bon_livraison_documents_document_id_fkey
      FOREIGN KEY (document_id) REFERENCES documents_clients(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_documents_uploaded_by_fkey'
  ) THEN
    ALTER TABLE bon_livraison_documents
      ADD CONSTRAINT bon_livraison_documents_uploaded_by_fkey
      FOREIGN KEY (uploaded_by) REFERENCES users(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_documents_unique_doc'
  ) THEN
    ALTER TABLE bon_livraison_documents
      ADD CONSTRAINT bon_livraison_documents_unique_doc UNIQUE (bon_livraison_id, document_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bon_livraison_documents_bl_id_idx ON bon_livraison_documents(bon_livraison_id);
CREATE INDEX IF NOT EXISTS bon_livraison_documents_created_at_idx ON bon_livraison_documents(created_at);
CREATE INDEX IF NOT EXISTS bon_livraison_documents_type_idx ON bon_livraison_documents(type);

-- -----------------------------------------------------------------------------
-- bon_livraison_event_log (append-only)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bon_livraison_event_log (
  id BIGSERIAL PRIMARY KEY,
  bon_livraison_id BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  old_values JSONB NULL,
  new_values JSONB NULL,
  user_id INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_event_log_bl_id_fkey'
  ) THEN
    ALTER TABLE bon_livraison_event_log
      ADD CONSTRAINT bon_livraison_event_log_bl_id_fkey
      FOREIGN KEY (bon_livraison_id) REFERENCES bon_livraison(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_event_log_user_id_fkey'
  ) THEN
    ALTER TABLE bon_livraison_event_log
      ADD CONSTRAINT bon_livraison_event_log_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bon_livraison_event_log_bl_id_idx ON bon_livraison_event_log(bon_livraison_id);
CREATE INDEX IF NOT EXISTS bon_livraison_event_log_created_at_idx ON bon_livraison_event_log(created_at);
CREATE INDEX IF NOT EXISTS bon_livraison_event_log_event_type_idx ON bon_livraison_event_log(event_type);

COMMIT;
