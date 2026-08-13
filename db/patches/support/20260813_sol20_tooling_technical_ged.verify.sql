\set ON_ERROR_STOP on

DO $$
BEGIN
  IF (
    SELECT count(*)
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'gestion_outils_mouvement_stock'
       AND column_name IN ('user_id', 'reason', 'source', 'note', 'commentaire', 'affaire_id')
  ) <> 6 THEN
    RAISE EXCEPTION 'SOL20_VERIFY_MOVEMENT_AUDIT_COLUMNS_MISSING';
  END IF;

  IF (
    SELECT count(*)
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'gestion_outils_outil'
       AND column_name IN ('reference_fabricant', 'designation_outil_cnc', 'codification')
  ) <> 3 THEN
    RAISE EXCEPTION 'SOL20_VERIFY_TOOL_IDENTITY_COLUMNS_MISSING';
  END IF;
END;
$$;

DO $$
DECLARE missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO missing
  FROM unnest(ARRAY[
    'public.outillage_tool_parameter_versions',
    'public.piece_version_tool_requirements',
    'public.outillage_allocations',
    'public.outillage_lifecycle_events'
  ]) AS expected(name)
  WHERE to_regclass(name) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'SOL20_VERIFY_MISSING_RELATIONS: %', array_to_string(missing, ', ');
  END IF;
END;
$$;

SELECT
  (SELECT count(*) FROM public.outillage_tool_parameter_versions) AS parameter_versions,
  (SELECT count(*) FROM public.piece_version_tool_requirements) AS tool_requirements,
  (SELECT count(*) FROM public.outillage_allocations) AS allocations,
  (SELECT count(*) FROM public.outillage_lifecycle_events) AS lifecycle_events;

DO $$
DECLARE
  invalid_allocation_quantities bigint;
  orphan_events bigint;
  duplicate_idempotency_keys bigint;
  overlapping_parameter_periods bigint;
BEGIN
  SELECT count(*) INTO invalid_allocation_quantities
  FROM public.outillage_allocations
  WHERE issued_quantity > reserved_quantity
     OR returned_quantity + broken_quantity + worn_quantity > issued_quantity;

  SELECT count(*) INTO orphan_events
  FROM public.outillage_lifecycle_events e
  LEFT JOIN public.outillage_allocations a ON a.id = e.allocation_id
  WHERE a.id IS NULL;

  SELECT count(*) INTO duplicate_idempotency_keys
  FROM (
    SELECT actor_user_id, idempotency_key
    FROM public.outillage_lifecycle_events
    GROUP BY actor_user_id, idempotency_key
    HAVING count(*) > 1
  ) duplicates;

  SELECT count(*) INTO overlapping_parameter_periods
  FROM public.outillage_tool_parameter_versions a
  JOIN public.outillage_tool_parameter_versions b
    ON b.id_outil=a.id_outil AND b.id>a.id
   AND tstzrange(a.effective_from,a.effective_to,'[)') && tstzrange(b.effective_from,b.effective_to,'[)');

  IF invalid_allocation_quantities > 0 OR orphan_events > 0
     OR duplicate_idempotency_keys > 0 OR overlapping_parameter_periods > 0 THEN
    RAISE EXCEPTION 'SOL20_VERIFY_INTEGRITY_FAILED: invalid_quantities=%, orphan_events=%, duplicate_keys=%, overlapping_periods=%',
      invalid_allocation_quantities, orphan_events, duplicate_idempotency_keys, overlapping_parameter_periods;
  END IF;
END;
$$;
