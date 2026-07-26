-- 20260726_production_execution_274.recompute-history.sql
-- Issue #274 — Recalcule la valeur DÉRIVÉE of_operations.temps_total_real.
--
-- Ce script ne modifie jamais les journaux sources (`production_pointages`,
-- `production_pointage_events`, `of_time_logs`). Il remplace uniquement le
-- total dérivé par la formule canonique, dans une transaction unique.
--
-- Usage obligatoire :
--   psql -v ON_ERROR_STOP=1 -v expected_database=cerp_test \
--     -f db/patches/support/20260726_production_execution_274.recompute-history.sql
--
-- Pour cerp_prod : sauvegarde restaurable, preflight et verify validés avant
-- l'appel, puis `-v expected_database=cerp_prod`.

\set ON_ERROR_STOP on

\if :{?expected_database}
\else
  \echo 'ERREUR: fournir -v expected_database=cerp_test (ou cerp_prod après validation).'
  \quit
\endif

SELECT current_database() = :'expected_database' AS production_274_target_ok \gset
\if :production_274_target_ok
\else
  \echo 'ERREUR: la base courante ne correspond pas à expected_database.'
  \quit
\endif

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $$
BEGIN
  IF to_regprocedure('public.fn_production_operation_real_hours(uuid)') IS NULL THEN
    RAISE EXCEPTION '#274 function fn_production_operation_real_hours(uuid) is missing';
  END IF;
END$$;

LOCK TABLE public.of_operations IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE production_274_recompute_preview
ON COMMIT DROP
AS
SELECT
  op.id,
  op.temps_total_real AS previous_hours,
  public.fn_production_operation_real_hours(op.id) AS target_hours
FROM public.of_operations op
WHERE op.temps_total_real IS DISTINCT FROM
      public.fn_production_operation_real_hours(op.id);

\echo '--- #274 rattrapage historique : aperçu ---'
SELECT
  count(*) AS operations_a_recalculer,
  ROUND(COALESCE(SUM(target_hours - previous_hours), 0), 3) AS ecart_total_heures
FROM production_274_recompute_preview;

UPDATE public.of_operations op
SET
  temps_total_real = preview.target_hours,
  updated_at = now()
FROM production_274_recompute_preview preview
WHERE op.id = preview.id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.of_operations op
    WHERE op.temps_total_real IS DISTINCT FROM
          public.fn_production_operation_real_hours(op.id)
  ) THEN
    RAISE EXCEPTION '#274 historical recompute verification failed';
  END IF;
END$$;

\echo '--- #274 rattrapage historique : résultat ---'
SELECT
  count(*) AS operations_recalculees,
  ROUND(COALESCE(SUM(target_hours - previous_hours), 0), 3) AS ecart_total_heures_applique
FROM production_274_recompute_preview;

COMMIT;
