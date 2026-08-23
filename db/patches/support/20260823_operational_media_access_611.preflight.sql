-- Read-only preflight for #611.
SELECT to_regclass('public.operational_media_assets') IS NULL AS registry_absent,
       to_regclass('public.operational_media_bindings') IS NULL AS bindings_absent,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'digest') AS pgcrypto_digest_available,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') AS uuid_available,
       to_regclass('public.machines') IS NOT NULL AS machines_present,
       to_regclass('public.clients') IS NOT NULL AS clients_present;

SELECT
  to_regclass('public.clients') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='client_id') AS clients_client_id_present,
  to_regclass('public.machines') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='machines' AND column_name='image_path') AS machines_image_path_present;

-- Read-only legacy compatibility gate. It intentionally does not call the
-- #611 normalizer because this script runs before the patch exists. Every
-- producer value is classified without returning a storage key or raw path:
-- blank/remote values are ignored; drive/UNC/traversal/ambiguous local values
-- are rejected; local keys must use a supported extension. SVG/SVGZ never
-- become executable operational media and must be converted offline first.
DO $$
DECLARE
  r record;
  v_local bigint;
  v_ignored bigint;
  v_rejected bigint;
  v_unsupported bigint;
  v_ambiguous bigint;
  v_allowed_extensions text[];
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('clients','client','client_id','logo_path','clients'),
    ('fournisseurs','fournisseur','id','logo','fournisseurs'),
    ('users','user','id','profile_picture','chat'),
    ('machines','machine','id','image_path','production'),
    ('gestion_outils_outil','outil','id_outil','image','outillage'),
    ('gestion_outils_outil','outil','id_outil','plan','outillage'),
    ('gestion_outils_outil','outil','id_outil','esquisse','outillage'),
    ('gestion_outils_famille','outil_famille','id_famille','image_path','outillage'),
    ('gestion_outils_geometrie','outil_geometrie','id_geometrie','image_path','outillage'),
    ('gestion_outils_fabricant','outil_fabricant','id_fabricant','logo','outillage')
  ) AS x(tbl, owner_type, id_col, field_col, module_key) LOOP
    IF to_regclass('public.' || r.tbl) IS NULL
       OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=r.tbl AND column_name=r.id_col)
       OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=r.tbl AND column_name=r.field_col) THEN
      CONTINUE;
    END IF;

    v_allowed_extensions := CASE
      WHEN r.owner_type = 'outil' AND r.field_col IN ('plan', 'esquisse')
        THEN ARRAY['png','jpg','jpeg','webp','gif','pdf']
      ELSE ARRAY['png','jpg','jpeg','webp','gif']
    END;

    EXECUTE format($sql$
      WITH source AS (
        SELECT %1$I::text AS raw FROM public.%2$I
      ), normalized_sources AS (
        SELECT raw, replace(btrim(raw), E'\\', '/') AS normalized_source
        FROM source
      ), candidates AS (
        SELECT raw, normalized_source,
          (lower(normalized_source) LIKE 'uploads/images/%%' OR ((normalized_source ~ '^[A-Za-z]:/' OR normalized_source ~ '^/') AND position('/uploads/images/' IN lower(normalized_source)) > 0)) AS has_legacy_marker,
          CASE
            WHEN raw IS NULL OR btrim(raw) = '' OR btrim(raw) ~* '^https?://' THEN NULL
            WHEN lower(normalized_source) LIKE 'uploads/images/%%'
              THEN substr(normalized_source, length('uploads/images/') + 1)
            WHEN (normalized_source ~ '^[A-Za-z]:/' OR normalized_source ~ '^/') AND position('/uploads/images/' IN lower(normalized_source)) > 0
              THEN substr(normalized_source, position('/uploads/images/' IN lower(normalized_source)) + length('/uploads/images/'))
            ELSE normalized_source
          END AS candidate
        FROM normalized_sources
      ), classified AS (
        SELECT CASE
          WHEN raw IS NULL OR btrim(raw) = '' OR btrim(raw) ~* '^https?://' THEN 'IGNORED'
          WHEN normalized_source ~* '^[A-Za-z][A-Za-z0-9+.-]*:' AND normalized_source !~* '^[A-Za-z]:/' THEN 'REJECTED'
          WHEN normalized_source ~ '[[:cntrl:]]'
            OR EXISTS (SELECT 1 FROM unnest(string_to_array(normalized_source, '/')) AS segment(value) WHERE value IN ('.', '..')) THEN 'REJECTED'
          WHEN candidate ~ '^[A-Za-z]:' OR candidate ~ '^//' OR candidate ~ ':' OR (NOT has_legacy_marker AND candidate ~ '^/')
            OR trim(both '/' FROM candidate) = ''
            OR EXISTS (SELECT 1 FROM unnest(string_to_array(trim(both '/' FROM candidate), '/')) AS segment(value) WHERE value IN ('.', '..') OR value = '') THEN 'REJECTED'
          ELSE 'LOCAL'
        END AS state,
        trim(both '/' FROM candidate) AS storage_key
        FROM candidates
      ), extensions AS (
        SELECT state, storage_key,
          CASE WHEN position('.' IN reverse(storage_key)) > 1
            THEN lower(reverse(split_part(reverse(storage_key), '.', 1)))
            ELSE NULL
          END AS extension
        FROM classified
      )
      SELECT
        count(*) FILTER (WHERE state = 'LOCAL'),
        count(*) FILTER (WHERE state = 'IGNORED'),
        count(*) FILTER (WHERE state = 'REJECTED'),
        count(*) FILTER (WHERE state = 'LOCAL' AND extension IS NOT NULL AND NOT (extension = ANY($1))),
        count(*) FILTER (WHERE state = 'LOCAL' AND extension IS NULL)
      FROM extensions
    $sql$, r.field_col, r.tbl)
    INTO v_local, v_ignored, v_rejected, v_unsupported, v_ambiguous
    USING v_allowed_extensions;

    RAISE NOTICE 'OPERATIONAL_MEDIA_PREFLIGHT_COMPATIBILITY owner_type=% field_key=% local=% ignored=% rejected=% unsupported=% ambiguous=%',
      r.owner_type, r.field_col, v_local, v_ignored, v_rejected, v_unsupported, v_ambiguous;
    IF v_unsupported > 0 OR v_ambiguous > 0 OR v_rejected > 0 THEN
      RAISE EXCEPTION 'OPERATIONAL_MEDIA_PREFLIGHT_COMPATIBILITY_BLOCKED owner_type=% field_key=% rejected=% unsupported=% ambiguous=%',
        r.owner_type, r.field_col, v_rejected, v_unsupported, v_ambiguous;
    END IF;
  END LOOP;
END $$;
