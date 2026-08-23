\set ON_ERROR_STOP on

SELECT current_database() AS database_name,
       current_user AS database_user,
       current_setting('server_version_num')::integer AS server_version_num;

DO $$
DECLARE missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO missing
  FROM unnest(ARRAY[
    'public.ged_document_classes', 'public.ged_document_links', 'public.gammes'
  ]) AS required(name)
  WHERE to_regclass(name) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'GED203_PREFLIGHT_MISSING_RELATIONS: %', array_to_string(missing, ', ');
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.ged_document_links l
      LEFT JOIN public.gammes g ON g.id::text = l.entity_id
     WHERE l.entity_type = 'GAMME' AND g.id IS NULL
  ) THEN
    RAISE EXCEPTION 'GED203_PREFLIGHT_STALE_GAMME_LINKS';
  END IF;
END;
$$;

SELECT now() AS backup_required_before_apply,
       'Take a consistent database backup and record its checksum outside this database.' AS operator_action;
