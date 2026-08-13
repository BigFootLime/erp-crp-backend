\set ON_ERROR_STOP on

SELECT current_database() AS database_name,
       current_user AS database_user,
       current_setting('server_version_num')::integer AS server_version_num,
       pg_size_pretty(pg_database_size(current_database())) AS database_size,
       pg_size_pretty(pg_tablespace_size('pg_default')) AS default_tablespace_size;

DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO missing
  FROM unnest(ARRAY[
    'public.users', 'public.gestion_outils_outil', 'public.gestion_outils_stock',
    'public.pieces_techniques', 'public.piece_technique_versions',
    'public.ordres_fabrication', 'public.ged_document_links',
    'public.ged_document_versions', 'public.ged_upload_sessions'
  ]) AS required(name)
  WHERE to_regclass(name) IS NULL;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'SOL20_PREFLIGHT_MISSING_RELATIONS: %', array_to_string(missing, ', ');
  END IF;
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'SOL20_PREFLIGHT_POSTGRES_TOO_OLD';
  END IF;
END;
$$;

DO $$
DECLARE
  invalid_piece_versions bigint;
  invalid_of_versions bigint;
BEGIN
  SELECT count(*) INTO invalid_piece_versions
  FROM public.piece_technique_versions v
  LEFT JOIN public.pieces_techniques p ON p.id = v.piece_technique_id
  WHERE p.id IS NULL;

  SELECT count(*) INTO invalid_of_versions
  FROM public.ordres_fabrication o
  LEFT JOIN public.piece_technique_versions v ON v.id = o.piece_technique_version_id
  WHERE o.piece_technique_version_id IS NOT NULL AND v.id IS NULL;

  IF invalid_piece_versions > 0 OR invalid_of_versions > 0 THEN
    RAISE EXCEPTION 'SOL20_PREFLIGHT_INVALID_TECHNICAL_REFERENCES: piece_versions=%, of_versions=%',
      invalid_piece_versions, invalid_of_versions;
  END IF;
END;
$$;

SELECT now() AS backup_required_before_apply,
       'Take a consistent database backup and record its checksum outside this database.' AS operator_action;
