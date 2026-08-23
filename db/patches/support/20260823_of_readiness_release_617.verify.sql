\set ON_ERROR_STOP on
BEGIN TRANSACTION;
DO $verify$
BEGIN
  IF to_regclass('public.of_release_decisions') IS NULL THEN RAISE EXCEPTION '#617 verify: release decision table missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.of_release_decisions'::regclass AND conname = 'of_release_decisions_override_reason_chk') THEN
    RAISE EXCEPTION '#617 verify: override reason constraint missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.of_release_decisions'::regclass AND conname = 'of_release_decisions_one_per_of_uk' AND contype = 'u') THEN
    RAISE EXCEPTION '#617 verify: one-release-per-OF constraint missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'of_release_decisions_of_decided_idx') THEN
    RAISE EXCEPTION '#617 verify: decision lookup index missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_of_execution_release_617' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION '#617 verify: OF execution release guard is missing or disabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.of_release_decisions'::regclass
      AND tgname = 'trg_of_release_decisions_append_only_617'
      AND tgenabled <> 'D'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '#617 verify: immutable ledger trigger missing or disabled';
  END IF;
END $verify$;
SELECT count(*) AS historical_release_decisions FROM public.of_release_decisions;

DO $immutability_probe$
DECLARE
  v_of_id bigint;
BEGIN
  SELECT of_id INTO v_of_id FROM public.of_release_decisions LIMIT 1;
  IF v_of_id IS NULL THEN RETURN; END IF;
  BEGIN
    UPDATE public.of_release_decisions SET evidence = evidence WHERE of_id = v_of_id;
    RAISE EXCEPTION '#617 verify: release evidence accepted UPDATE';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END $immutability_probe$;
COMMIT;
