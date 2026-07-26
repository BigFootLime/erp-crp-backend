-- 20260726_production_execution_274.smoke.sql
-- Test transactionnel de l'adaptateur legacy #274.
--
-- Crée des fixtures minimales, exerce START / double START / STOP, vérifie la
-- corrélation et le calcul, puis ROLLBACK : aucune donnée de test ne persiste.

\set ON_ERROR_STOP on

BEGIN;

-- Le smoke s'exécute avec le même rôle que l'API. Il valide donc aussi les
-- privilèges runtime créés par le patch, pas seulement la syntaxe superuser.
SET LOCAL ROLE cerp_app;

DO $$
DECLARE
  v_user_id integer;
  v_piece_id uuid;
  v_of_id bigint;
  v_operation_id uuid;
  v_time_log_id uuid;
  v_pointage_id uuid;
  v_started_at timestamptz;
  v_ended_at timestamptz;
  v_legacy_duration integer;
  v_pointage_duration integer;
  v_real_hours numeric;
  v_second_start_refused boolean := false;
BEGIN
  SELECT id INTO v_user_id
  FROM public.users
  ORDER BY id
  LIMIT 1;

  SELECT id INTO v_piece_id
  FROM public.pieces_techniques
  ORDER BY id
  LIMIT 1;

  IF v_user_id IS NULL OR v_piece_id IS NULL THEN
    RAISE EXCEPTION '#274 smoke requires at least one user and one technical piece';
  END IF;

  INSERT INTO public.ordres_fabrication (
    numero,
    piece_technique_id,
    quantite_lancee,
    statut,
    created_by,
    updated_by
  )
  VALUES (
    'OF-TEST-274-SMOKE',
    v_piece_id,
    1,
    'EN_COURS',
    v_user_id,
    v_user_id
  )
  RETURNING id INTO v_of_id;

  INSERT INTO public.of_operations (
    of_id,
    phase,
    designation,
    status
  )
  VALUES (
    v_of_id,
    10,
    'Test adaptateur #274',
    'RUNNING'
  )
  RETURNING id INTO v_operation_id;

  v_started_at := date_trunc('minute', clock_timestamp()) - interval '10 minutes';
  v_ended_at := date_trunc('minute', clock_timestamp());

  INSERT INTO public.of_time_logs (
    of_operation_id,
    user_id,
    started_at,
    type,
    comment
  )
  VALUES (
    v_operation_id,
    v_user_id,
    v_started_at,
    'PRODUCTION',
    '#274 smoke start'
  )
  RETURNING id, pointage_id INTO v_time_log_id, v_pointage_id;

  IF v_pointage_id IS NULL THEN
    RAISE EXCEPTION '#274 smoke: legacy start was not correlated';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.production_pointages
    WHERE id = v_pointage_id
      AND operation_id = v_operation_id
      AND operator_user_id = v_user_id
      AND status = 'RUNNING'
      AND source = 'LEGACY_TIME_LOG'
  ) THEN
    RAISE EXCEPTION '#274 smoke: canonical RUNNING pointage is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.production_pointage_events
    WHERE pointage_id = v_pointage_id
      AND event_type = 'START'
  ) THEN
    RAISE EXCEPTION '#274 smoke: START event is missing';
  END IF;

  BEGIN
    INSERT INTO public.of_time_logs (
      of_operation_id,
      user_id,
      started_at,
      type
    )
    VALUES (
      v_operation_id,
      v_user_id,
      v_started_at,
      'PRODUCTION'
    );
  EXCEPTION
    WHEN unique_violation OR exclusion_violation THEN
      v_second_start_refused := true;
  END;

  IF NOT v_second_start_refused THEN
    RAISE EXCEPTION '#274 smoke: a second active segment was accepted';
  END IF;

  UPDATE public.of_time_logs
  SET
    ended_at = v_ended_at,
    comment = '#274 smoke stop'
  WHERE id = v_time_log_id;

  SELECT duration_minutes
  INTO v_legacy_duration
  FROM public.of_time_logs
  WHERE id = v_time_log_id;

  SELECT duration_minutes
  INTO v_pointage_duration
  FROM public.production_pointages
  WHERE id = v_pointage_id
    AND status = 'DONE';

  IF v_legacy_duration IS DISTINCT FROM 10
     OR v_pointage_duration IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION
      '#274 smoke: duration mismatch (legacy %, canonical %)',
      v_legacy_duration,
      v_pointage_duration;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.production_pointage_events
    WHERE pointage_id = v_pointage_id
      AND event_type = 'STOP'
  ) THEN
    RAISE EXCEPTION '#274 smoke: STOP event is missing';
  END IF;

  v_real_hours := public.fn_production_operation_real_hours(v_operation_id);
  IF v_real_hours IS DISTINCT FROM 0.167::numeric THEN
    RAISE EXCEPTION '#274 smoke: expected 0.167 real hour, got %', v_real_hours;
  END IF;

  PERFORM public.fn_production_recompute_operation_real_time(v_operation_id);

  IF NOT EXISTS (
    SELECT 1
    FROM public.of_operations
    WHERE id = v_operation_id
      AND temps_total_real = 0.167::numeric
  ) THEN
    RAISE EXCEPTION '#274 smoke: persisted real time is inconsistent';
  END IF;

  RAISE NOTICE
    '#274 smoke OK: legacy %, pointage %, duration % minutes, total % hour',
    v_time_log_id,
    v_pointage_id,
    v_pointage_duration,
    v_real_hours;
END$$;

ROLLBACK;

\echo '=== #274 smoke terminé — transaction annulée, aucune fixture persistée ==='
