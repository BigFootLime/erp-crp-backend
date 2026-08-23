-- #611 read-only post-deploy verification. Expected producer rows are built
-- from source columns, not inferred from bindings: shared storage keys still
-- require one binding for every owner/field tuple.
SELECT to_regclass('public.operational_media_assets') IS NOT NULL AS registry_present,
       to_regclass('public.operational_media_bindings') IS NOT NULL AS bindings_present,
       (SELECT count(*) FROM public.operational_media_assets) AS asset_count,
       (SELECT count(*) FROM public.operational_media_bindings) AS binding_count;

SELECT count(*) = 0 AS no_invalid_storage_keys
FROM public.operational_media_assets
WHERE storage_key <> public.fn_operational_media_normalize_key(storage_key)
   OR storage_key ~ '(^|/)[.][.](/|$)' OR storage_key ~ '^/' OR storage_key ~ '[[:cntrl:]]';

SELECT count(*) = 0 AS no_active_asset_missing_integrity
FROM public.operational_media_assets
WHERE status = 'ACTIVE' AND (mime_type IS NULL OR size_bytes IS NULL OR sha256 IS NULL OR scan_status <> 'CLEAN');

-- A tool's primary image is raster-only. PDF drawings belong to `plan` or
-- `esquisse`; this catches malformed historical activation independently of
-- the DTO projection.
SELECT count(*) = 0 AS no_pdf_primary_tool_images
FROM public.operational_media_assets a
JOIN public.operational_media_bindings b ON b.asset_id = a.id
WHERE a.status = 'ACTIVE' AND a.mime_type = 'application/pdf'
  AND b.owner_type = 'outil' AND b.field_key = 'image';

SELECT count(*) = 0 AS no_active_media_with_incompatible_binding_mime
FROM public.operational_media_assets a
JOIN public.operational_media_bindings b ON b.asset_id = a.id
WHERE a.status = 'ACTIVE' AND a.mime_type = 'application/pdf'
  AND NOT (b.owner_type = 'outil' AND b.field_key IN ('plan', 'esquisse'));

SELECT status, scan_status, count(*) AS assets
FROM public.operational_media_assets GROUP BY status, scan_status ORDER BY status, scan_status;

SELECT count(*) = 0 AS no_binding_collisions
FROM (SELECT owner_type, owner_id, field_key FROM public.operational_media_bindings GROUP BY 1,2,3 HAVING count(*) > 1) collisions;

DROP TABLE IF EXISTS operational_media_expected_bindings_611;
CREATE TEMP TABLE operational_media_expected_bindings_611 (
  owner_type text NOT NULL, owner_id text NOT NULL, field_key text NOT NULL,
  module_key text NOT NULL, storage_key text NOT NULL
) ON COMMIT PRESERVE ROWS;

DO $$
DECLARE r record;
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
    IF to_regclass('public.' || r.tbl) IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=r.tbl AND column_name=r.id_col)
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=r.tbl AND column_name=r.field_col) THEN
      EXECUTE format(
        'INSERT INTO operational_media_expected_bindings_611(owner_type,owner_id,field_key,module_key,storage_key)
         SELECT %1$L, s.%2$I::text, %3$L, %4$L, public.fn_operational_media_normalize_key(s.%5$I)
           FROM public.%6$I s
          WHERE public.fn_operational_media_normalize_key(s.%5$I) IS NOT NULL',
        r.owner_type, r.id_col, r.field_col, r.module_key, r.field_col, r.tbl
      );
    END IF;
  END LOOP;
END $$;

WITH compared AS (
  SELECT e.owner_type, e.field_key, e.owner_id, e.storage_key,
         b.asset_id, a.storage_key AS bound_storage_key, b.module_key AS bound_module_key
    FROM operational_media_expected_bindings_611 e
    LEFT JOIN public.operational_media_bindings b
      ON b.owner_type=e.owner_type AND b.owner_id=e.owner_id AND b.field_key=e.field_key
    LEFT JOIN public.operational_media_assets a ON a.id=b.asset_id
)
SELECT owner_type, field_key,
       count(*) AS expected_rows,
       count(asset_id) FILTER (WHERE bound_storage_key = storage_key AND bound_module_key IS NOT NULL) AS matching_bindings,
       count(*) FILTER (WHERE asset_id IS NULL OR bound_storage_key IS DISTINCT FROM storage_key OR bound_module_key IS NULL) AS missing_or_mismatched,
       count(DISTINCT storage_key) AS distinct_storage_keys
FROM compared GROUP BY owner_type, field_key ORDER BY owner_type, field_key;

SELECT count(*) = 0 AS every_expected_producer_row_is_bound
FROM operational_media_expected_bindings_611 e
LEFT JOIN public.operational_media_bindings b
  ON b.owner_type=e.owner_type AND b.owner_id=e.owner_id AND b.field_key=e.field_key
LEFT JOIN public.operational_media_assets a ON a.id=b.asset_id
WHERE b.asset_id IS NULL OR a.storage_key IS DISTINCT FROM e.storage_key OR b.module_key IS DISTINCT FROM e.module_key;
