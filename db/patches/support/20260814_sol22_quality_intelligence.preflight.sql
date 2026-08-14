\set ON_ERROR_STOP on

DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF current_setting('server_version_num')::int < 140000 THEN
    RAISE EXCEPTION 'PostgreSQL 14+ requis';
  END IF;
  IF to_regclass('public.quality_control') IS NULL THEN missing := array_append(missing, 'quality_control'); END IF;
  IF to_regclass('public.quality_control_points') IS NULL THEN missing := array_append(missing, 'quality_control_points'); END IF;
  IF to_regclass('public.non_conformity') IS NULL THEN missing := array_append(missing, 'non_conformity'); END IF;
  IF to_regclass('public.quality_action') IS NULL THEN missing := array_append(missing, 'quality_action'); END IF;
  IF to_regclass('public.quality_documents') IS NULL THEN missing := array_append(missing, 'quality_documents'); END IF;
  IF to_regclass('public.metrologie_equipements') IS NULL THEN missing := array_append(missing, 'metrologie_equipements'); END IF;
  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Prerequis SOL-22 manquants: %', array_to_string(missing, ', ');
  END IF;
END $$;

SELECT current_database() AS database_name,
       current_setting('server_version') AS postgres_version,
       pg_size_pretty(pg_database_size(current_database())) AS database_size,
       (SELECT COUNT(*) FROM public.quality_control) AS quality_controls,
       (SELECT COUNT(*) FROM public.non_conformity) AS non_conformities,
       (SELECT COUNT(*) FROM public.quality_action) AS quality_actions,
       (SELECT COUNT(*) FROM public.metrologie_equipements) AS metrology_equipment;

SELECT COUNT(*) AS verified_actions_without_comment
FROM public.quality_action
WHERE status = 'VERIFIED'
  AND (effectiveness_comment IS NULL OR char_length(btrim(effectiveness_comment)) < 5);
