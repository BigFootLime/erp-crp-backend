\set ON_ERROR_STOP on

-- #170 verify — structures
SELECT
  to_regclass('public.of_output_lots') IS NOT NULL AS has_of_output_lots,
  to_regclass('public.of_generation_batches') IS NOT NULL AS has_generation_batches,
  to_regclass('public.of_structure_snapshot') IS NOT NULL AS has_structure_snapshot,
  to_regclass('public.of_technical_snapshots') IS NOT NULL AS has_technical_snapshots;

SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'of_generation_batches'
  AND column_name IN ('affaire_id', 'idempotency_key', 'request_hash', 'source_hash', 'result')
ORDER BY column_name;

SELECT indexname FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'of_generation_batches_idempotency_uq',
    'of_generation_batches_affaire_idx',
    'of_output_lots_of_idx',
    'of_output_lots_lot_idx'
  )
ORDER BY indexname;

SELECT tgname FROM pg_trigger
WHERE tgrelid IN (
    'public.ordres_fabrication'::regclass,
    'public.of_structure_snapshot'::regclass,
    'public.of_generation_batches'::regclass
  )
  AND tgname IN (
    'trg_prevent_of_numero_mutation',
    'trg_prevent_of_structure_snapshot_mutation',
    'trg_protect_of_generation_batch'
  )
ORDER BY tgname;

-- #170 verify — behavioural probes (rolled back, leave no trace)
DO $$
DECLARE
  v_of_id bigint;
  v_batch_id uuid;
  v_snapshot_id uuid;
BEGIN
  SELECT id INTO v_of_id FROM public.ordres_fabrication WHERE numero IS NOT NULL LIMIT 1;
  IF v_of_id IS NOT NULL THEN
    BEGIN
      UPDATE public.ordres_fabrication SET numero = numero || '-X' WHERE id = v_of_id;
      RAISE EXCEPTION 'verify FAILED: OF numero mutation was accepted';
    EXCEPTION WHEN SQLSTATE '23514' THEN
      RAISE NOTICE 'ok: OF numero mutation rejected';
    END;
  ELSE
    RAISE NOTICE 'skip: no OF row available for numero probe';
  END IF;

  SELECT id INTO v_snapshot_id FROM public.of_structure_snapshot LIMIT 1;
  IF v_snapshot_id IS NOT NULL THEN
    BEGIN
      DELETE FROM public.of_structure_snapshot WHERE id = v_snapshot_id;
      RAISE EXCEPTION 'verify FAILED: structure snapshot delete was accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN
      RAISE NOTICE 'ok: structure snapshot delete rejected';
    END;
  ELSE
    RAISE NOTICE 'skip: no structure snapshot row available for probe';
  END IF;

  SELECT id INTO v_batch_id FROM public.of_generation_batches LIMIT 1;
  IF v_batch_id IS NOT NULL THEN
    BEGIN
      DELETE FROM public.of_generation_batches WHERE id = v_batch_id;
      RAISE EXCEPTION 'verify FAILED: generation batch delete was accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN
      RAISE NOTICE 'ok: generation batch delete rejected';
    END;

    BEGIN
      UPDATE public.of_generation_batches SET requested_qty = requested_qty + 1 WHERE id = v_batch_id;
      RAISE EXCEPTION 'verify FAILED: generation batch business mutation was accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN
      RAISE NOTICE 'ok: generation batch business mutation rejected';
    END;
  ELSE
    RAISE NOTICE 'skip: no generation batch row available for probe';
  END IF;
END $$;
