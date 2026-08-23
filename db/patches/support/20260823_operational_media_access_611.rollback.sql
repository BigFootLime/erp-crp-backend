-- Rollback is additive and intentionally leaves legacy image columns/files intact.
BEGIN;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('clients','logo_path'),('fournisseurs','logo'),('users','profile_picture'),('machines','image_path'),('gestion_outils_outil','image'),
    ('gestion_outils_outil','plan'),('gestion_outils_outil','esquisse'),
    ('gestion_outils_famille','image_path'),('gestion_outils_geometrie','image_path'),
    ('gestion_outils_fabricant','logo')
  ) AS x(tbl, field_col) LOOP
    IF to_regclass('public.' || r.tbl) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_operational_media_%1$s_%2$s ON public.%1$I', r.tbl, r.field_col);
    END IF;
  END LOOP;
END $$;
DROP TABLE IF EXISTS public.operational_media_bindings;
DROP TABLE IF EXISTS public.operational_media_assets;
DROP FUNCTION IF EXISTS public.fn_operational_media_enforce_binding_mime();
DROP FUNCTION IF EXISTS public.fn_operational_media_sync_binding();
DROP FUNCTION IF EXISTS public.fn_operational_media_normalize_key(text);
COMMIT;
