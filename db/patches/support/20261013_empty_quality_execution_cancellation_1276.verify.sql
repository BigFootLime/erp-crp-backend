DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
    WHERE t.typname='quality_control_status' AND e.enumlabel='CANCELLED')
    THEN RAISE EXCEPTION 'cancellation status missing'; END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='quality_control'
    AND column_name IN('execution_cancelled_at','execution_cancelled_by','execution_cancellation_reason'))<>3
    THEN RAISE EXCEPTION 'cancellation metadata missing'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN(
    'trg_protect_empty_quality_cancellation_1276','trg_refuse_cancelled_quality_point_1276','trg_refuse_cancelled_quality_decision_1276'))<>3
    THEN RAISE EXCEPTION 'cancellation guards missing'; END IF;
  IF EXISTS(SELECT 1 FROM public.quality_control q WHERE status::text='CANCELLED' AND (
    validation_date IS NOT NULL OR execution_cancelled_at IS NULL OR execution_cancelled_by IS NULL
    OR EXISTS(SELECT 1 FROM public.quality_control_points WHERE quality_control_id=q.id)
    OR EXISTS(SELECT 1 FROM public.quality_release_decision WHERE quality_control_id=q.id)))
    THEN RAISE EXCEPTION 'cancelled control has incompatible evidence'; END IF;
END $$;
SELECT 'empty quality cancellation 1276 guards verified' AS result;
