-- Issue #226 - Préparation expédition, allocations sourcées et bons de livraison.
-- Additive and idempotent. This patch must be applied through the normal reviewed
-- migration workflow; it is never executed automatically by the application.

BEGIN;

ALTER TABLE public.bon_livraison
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;

ALTER TABLE public.bon_livraison_ligne_allocations
  ADD COLUMN IF NOT EXISTS magasin_id uuid NULL,
  ADD COLUMN IF NOT EXISTS emplacement_id bigint NULL,
  ADD COLUMN IF NOT EXISTS location_id uuid NULL,
  ADD COLUMN IF NOT EXISTS stock_level_id uuid NULL,
  ADD COLUMN IF NOT EXISTS stock_batch_id uuid NULL,
  ADD COLUMN IF NOT EXISTS reservation_id uuid NULL;

ALTER TABLE public.bon_livraison_documents
  ADD COLUMN IF NOT EXISTS checksum_sha256 text NULL,
  ADD COLUMN IF NOT EXISTS file_size_bytes bigint NULL,
  ADD COLUMN IF NOT EXISTS mime_type text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bl_allocations_source_shape_226_ck'
      AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations
      ADD CONSTRAINT bl_allocations_source_shape_226_ck
      CHECK (
        (
          magasin_id IS NULL
          AND emplacement_id IS NULL
          AND location_id IS NULL
          AND stock_level_id IS NULL
          AND stock_batch_id IS NULL
          AND reservation_id IS NULL
        )
        OR (
          magasin_id IS NOT NULL
          AND emplacement_id IS NOT NULL
          AND location_id IS NOT NULL
          AND stock_level_id IS NOT NULL
          AND (
            (lot_id IS NULL AND stock_batch_id IS NULL)
            OR (lot_id IS NOT NULL AND stock_batch_id IS NOT NULL)
          )
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bl_allocations_magasin_226_fkey'
      AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations
      ADD CONSTRAINT bl_allocations_magasin_226_fkey
      FOREIGN KEY (magasin_id) REFERENCES public.magasins(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bl_allocations_emplacement_226_fkey'
      AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations
      ADD CONSTRAINT bl_allocations_emplacement_226_fkey
      FOREIGN KEY (emplacement_id) REFERENCES public.emplacements(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bl_allocations_location_226_fkey'
      AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations
      ADD CONSTRAINT bl_allocations_location_226_fkey
      FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bl_allocations_stock_level_226_fkey'
      AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations
      ADD CONSTRAINT bl_allocations_stock_level_226_fkey
      FOREIGN KEY (stock_level_id) REFERENCES public.stock_levels(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bl_allocations_stock_batch_226_fkey'
      AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations
      ADD CONSTRAINT bl_allocations_stock_batch_226_fkey
      FOREIGN KEY (stock_batch_id) REFERENCES public.stock_batches(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bl_allocations_reservation_226_fkey'
      AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations
      ADD CONSTRAINT bl_allocations_reservation_226_fkey
      FOREIGN KEY (reservation_id) REFERENCES public.stock_reservations(id) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bl_documents_checksum_226_ck'
      AND conrelid = 'public.bon_livraison_documents'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_documents
      ADD CONSTRAINT bl_documents_checksum_226_ck
      CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[A-Fa-f0-9]{64}$') NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bl_documents_size_226_ck'
      AND conrelid = 'public.bon_livraison_documents'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_documents
      ADD CONSTRAINT bl_documents_size_226_ck
      CHECK (file_size_bytes IS NULL OR file_size_bytes > 0) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bl_allocations_source_226_idx
  ON public.bon_livraison_ligne_allocations(stock_level_id, stock_batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS bl_allocations_reservation_226_uq
  ON public.bon_livraison_ligne_allocations(reservation_id)
  WHERE reservation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.bon_livraison_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  command_type text NOT NULL,
  bon_livraison_id uuid NOT NULL REFERENCES public.bon_livraison(id) ON DELETE RESTRICT,
  request_payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bl_command_receipts_actor_key_226_uq UNIQUE (actor_user_id, idempotency_key),
  CONSTRAINT bl_command_receipts_key_len_226_ck CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT bl_command_receipts_hash_226_ck CHECK (request_hash ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT bl_command_receipts_type_226_ck CHECK (command_type IN ('SHIP'))
);

CREATE INDEX IF NOT EXISTS bl_command_receipts_bl_226_idx
  ON public.bon_livraison_command_receipts(bon_livraison_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bl_command_receipts_correlation_226_idx
  ON public.bon_livraison_command_receipts(correlation_id);

CREATE TABLE IF NOT EXISTS public.bon_livraison_delivery_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bon_livraison_id uuid NOT NULL REFERENCES public.bon_livraison(id) ON DELETE RESTRICT,
  proof_type text NOT NULL,
  delivered_at timestamptz NOT NULL,
  received_by_name text NULL,
  document_id uuid NULL REFERENCES public.documents_clients(id) ON DELETE RESTRICT,
  note text NULL,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bl_delivery_proof_type_226_ck CHECK (
    proof_type IN ('RECIPIENT_ACK', 'CARRIER_DOCUMENT', 'PHOTO', 'EXTERNAL_SIGNATURE')
  ),
  CONSTRAINT bl_delivery_proof_name_226_ck CHECK (
    received_by_name IS NULL OR char_length(received_by_name) BETWEEN 1 AND 200
  ),
  CONSTRAINT bl_delivery_proof_note_226_ck CHECK (
    note IS NULL OR char_length(note) <= 2000
  )
);

CREATE INDEX IF NOT EXISTS bl_delivery_proofs_bl_226_idx
  ON public.bon_livraison_delivery_proofs(bon_livraison_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.erp_outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  correlation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz NULL,
  last_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT erp_outbox_status_226_ck CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED')),
  CONSTRAINT erp_outbox_attempt_226_ck CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS erp_outbox_pending_226_idx
  ON public.erp_outbox_events(status, available_at, created_at)
  WHERE status IN ('PENDING', 'FAILED');
CREATE INDEX IF NOT EXISTS erp_outbox_aggregate_226_idx
  ON public.erp_outbox_events(aggregate_type, aggregate_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.fn_bump_bon_livraison_version_226()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bump_bon_livraison_version_226 ON public.bon_livraison;
CREATE TRIGGER trg_bump_bon_livraison_version_226
BEFORE UPDATE ON public.bon_livraison
FOR EACH ROW EXECUTE FUNCTION public.fn_bump_bon_livraison_version_226();

CREATE OR REPLACE FUNCTION public.fn_protect_livraison_evidence_226()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'delivery evidence is immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_bl_event_log_226 ON public.bon_livraison_event_log;
CREATE TRIGGER trg_protect_bl_event_log_226
BEFORE UPDATE OR DELETE ON public.bon_livraison_event_log
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_livraison_evidence_226();

DROP TRIGGER IF EXISTS trg_protect_bl_command_receipts_226 ON public.bon_livraison_command_receipts;
CREATE TRIGGER trg_protect_bl_command_receipts_226
BEFORE UPDATE OR DELETE ON public.bon_livraison_command_receipts
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_livraison_evidence_226();

DROP TRIGGER IF EXISTS trg_protect_bl_delivery_proofs_226 ON public.bon_livraison_delivery_proofs;
CREATE TRIGGER trg_protect_bl_delivery_proofs_226
BEFORE UPDATE OR DELETE ON public.bon_livraison_delivery_proofs
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_livraison_evidence_226();

CREATE OR REPLACE VIEW public.v_bon_livraison_reliquats_226 AS
SELECT
  cl.id AS commande_ligne_id,
  cl.commande_id,
  cl.quantite::numeric(18, 3) AS quantite_commandee,
  COALESCE(SUM(
    CASE
      WHEN bl.statut IN ('SHIPPED', 'DELIVERED') THEN bll.quantite
      ELSE 0
    END
  ), 0)::numeric(18, 3) AS quantite_expediee,
  GREATEST(
    cl.quantite - COALESCE(SUM(
      CASE
        WHEN bl.statut IN ('SHIPPED', 'DELIVERED') THEN bll.quantite
        ELSE 0
      END
    ), 0),
    0
  )::numeric(18, 3) AS quantite_restante
FROM public.commande_ligne cl
LEFT JOIN public.bon_livraison_ligne bll ON bll.commande_ligne_id = cl.id
LEFT JOIN public.bon_livraison bl ON bl.id = bll.bon_livraison_id
GROUP BY cl.id, cl.commande_id, cl.quantite;

COMMIT;
