\set ON_ERROR_STOP on
BEGIN;

-- #170 rollback is conservative: production receipts and generation evidence
-- are industrial traceability and must never be destroyed by a rollback.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.of_output_lots)
     OR EXISTS (
       SELECT 1 FROM public.of_generation_batches
       WHERE idempotency_key IS NOT NULL OR source_hash IS NOT NULL OR result IS NOT NULL
     ) THEN
    RAISE EXCEPTION '#170 rollback refused: business rows exist; preserve industrial traceability';
  END IF;
END $$;

-- Remove protections first so the additive columns can be dropped.
DROP TRIGGER IF EXISTS trg_protect_of_generation_batch ON public.of_generation_batches;
DROP FUNCTION IF EXISTS public.fn_protect_of_generation_batch();
DROP TRIGGER IF EXISTS trg_prevent_of_structure_snapshot_mutation ON public.of_structure_snapshot;
DROP FUNCTION IF EXISTS public.fn_prevent_of_structure_snapshot_mutation();
DROP TRIGGER IF EXISTS trg_prevent_of_numero_mutation ON public.ordres_fabrication;
DROP FUNCTION IF EXISTS public.fn_prevent_of_numero_mutation();

ALTER TABLE public.of_generation_batches
  DROP CONSTRAINT IF EXISTS of_generation_batches_source_type_ck,
  DROP CONSTRAINT IF EXISTS of_generation_batches_idempotency_key_len_ck,
  DROP CONSTRAINT IF EXISTS of_generation_batches_affaire_id_fkey;
DROP INDEX IF EXISTS public.of_generation_batches_idempotency_uq;
DROP INDEX IF EXISTS public.of_generation_batches_affaire_idx;
ALTER TABLE public.of_generation_batches
  DROP COLUMN IF EXISTS result,
  DROP COLUMN IF EXISTS source_hash,
  DROP COLUMN IF EXISTS request_hash,
  DROP COLUMN IF EXISTS idempotency_key,
  DROP COLUMN IF EXISTS affaire_id;

ALTER TABLE public.ordres_fabrication
  DROP CONSTRAINT IF EXISTS ordres_fabrication_no_self_parent_ck;

-- of_output_lots is only dropped when empty (guard above); on a live database
-- where the table pre-existed this patch, the guard always refuses.
DROP TABLE IF EXISTS public.of_output_lots;

DELETE FROM public.cerp_schema_migrations
WHERE filename = '20260722_of_work_orders_170.sql'
  AND to_regclass('public.of_output_lots') IS NULL;

COMMIT;
