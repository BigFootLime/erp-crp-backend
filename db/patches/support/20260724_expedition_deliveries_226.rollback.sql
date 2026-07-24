-- Guarded rollback for issue #226. Never run automatically.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.bon_livraison_command_receipts LIMIT 1)
    OR EXISTS (SELECT 1 FROM public.bon_livraison_delivery_proofs LIMIT 1)
    OR EXISTS (
      SELECT 1
      FROM public.bon_livraison_ligne_allocations
      WHERE magasin_id IS NOT NULL
         OR reservation_id IS NOT NULL
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1
      FROM public.bon_livraison_documents
      WHERE checksum_sha256 IS NOT NULL
         OR file_size_bytes IS NOT NULL
         OR mime_type IS NOT NULL
      LIMIT 1
    )
  THEN
    RAISE EXCEPTION '#226 rollback refused: delivery evidence or sourced allocations exist';
  END IF;
END $$;

BEGIN;

DROP VIEW IF EXISTS public.v_bon_livraison_reliquats_226;
DROP TRIGGER IF EXISTS trg_protect_bl_delivery_proofs_226 ON public.bon_livraison_delivery_proofs;
DROP TRIGGER IF EXISTS trg_protect_bl_command_receipts_226 ON public.bon_livraison_command_receipts;
DROP TRIGGER IF EXISTS trg_protect_bl_event_log_226 ON public.bon_livraison_event_log;
DROP TRIGGER IF EXISTS trg_bump_bon_livraison_version_226 ON public.bon_livraison;
DROP FUNCTION IF EXISTS public.fn_protect_livraison_evidence_226();
DROP FUNCTION IF EXISTS public.fn_bump_bon_livraison_version_226();
DROP TABLE IF EXISTS public.bon_livraison_delivery_proofs;
DROP TABLE IF EXISTS public.bon_livraison_command_receipts;

ALTER TABLE public.bon_livraison_ligne_allocations
  DROP CONSTRAINT IF EXISTS bl_allocations_reservation_226_fkey,
  DROP CONSTRAINT IF EXISTS bl_allocations_stock_batch_226_fkey,
  DROP CONSTRAINT IF EXISTS bl_allocations_stock_level_226_fkey,
  DROP CONSTRAINT IF EXISTS bl_allocations_location_226_fkey,
  DROP CONSTRAINT IF EXISTS bl_allocations_emplacement_226_fkey,
  DROP CONSTRAINT IF EXISTS bl_allocations_magasin_226_fkey,
  DROP CONSTRAINT IF EXISTS bl_allocations_source_shape_226_ck,
  DROP COLUMN IF EXISTS reservation_id,
  DROP COLUMN IF EXISTS stock_batch_id,
  DROP COLUMN IF EXISTS stock_level_id,
  DROP COLUMN IF EXISTS location_id,
  DROP COLUMN IF EXISTS emplacement_id,
  DROP COLUMN IF EXISTS magasin_id;

ALTER TABLE public.bon_livraison
  DROP COLUMN IF EXISTS row_version;

ALTER TABLE public.bon_livraison_documents
  DROP CONSTRAINT IF EXISTS bl_documents_size_226_ck,
  DROP CONSTRAINT IF EXISTS bl_documents_checksum_226_ck,
  DROP COLUMN IF EXISTS mime_type,
  DROP COLUMN IF EXISTS file_size_bytes,
  DROP COLUMN IF EXISTS checksum_sha256;

-- erp_outbox_events is intentionally retained: it is a shared integration seam.

COMMIT;
