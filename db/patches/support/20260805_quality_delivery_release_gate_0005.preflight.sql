\set ON_ERROR_STOP on

DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.users') IS NULL THEN missing := array_append(missing, 'users'); END IF;
  IF to_regclass('public.bon_livraison_pack_versions') IS NULL THEN missing := array_append(missing, 'bon_livraison_pack_versions'); END IF;
  IF to_regclass('public.quality_documents') IS NULL THEN missing := array_append(missing, 'quality_documents'); END IF;
  IF to_regclass('public.quality_release_decision') IS NULL THEN missing := array_append(missing, 'quality_release_decision'); END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0005 prerequisites missing: %', array_to_string(missing, ', ');
  END IF;
END;
$$;
