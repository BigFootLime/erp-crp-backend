\set ON_ERROR_STOP on

BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'cerp_test'
     OR current_setting('cerp.migration_rehearsal', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Production readiness rollback is test-only; restore the validated backup for a real rollback';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fn_enforce_business_prerequisites()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger$
DECLARE
  v_flow text := upper(TG_ARGV[0]);
  v_missing jsonb;
BEGIN
  IF v_flow = 'PRODUCTION'
     AND COALESCE(to_jsonb(NEW)->>'statut', '') NOT IN ('PLANIFIE', 'EN_COURS', 'EN_PAUSE') THEN
    RETURN NEW;
  END IF;
  SELECT jsonb_agg(to_jsonb(status_row) - 'flow' ORDER BY status_row.prerequisite_code)
  INTO v_missing
  FROM public.fn_business_prerequisite_status(v_flow) status_row
  WHERE NOT status_row.ready;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Référentiels incomplets pour démarrer le flux %', v_flow
      USING ERRCODE='P2606', DETAIL=v_missing::text;
  END IF;
  RETURN NEW;
END
$trigger$;

DROP FUNCTION public.fn_business_prerequisite_status_v2(text);

COMMIT;
