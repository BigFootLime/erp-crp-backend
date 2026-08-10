-- Correctif #446 : raccourcis Base OLD et Base NEW dans la navigation Stock.
--
-- ADDITIF ET IDEMPOTENT : conserve toutes les clés de navigation déjà publiées
-- et ajoute seulement les deux sous-pages livrées par le frontend.
--
-- Prérequis : 20260727_admin_access_tower_326.sql.
-- Preflight : db/patches/support/20260810_stock_old_new_navigation_446.preflight.sql
-- Verify    : db/patches/support/20260810_stock_old_new_navigation_446.verify.sql

BEGIN;

DO $catalog_guard$
BEGIN
  IF to_regclass('public.app_modules') IS NULL THEN
    RAISE EXCEPTION
      'navigation #446 : public.app_modules absent — appliquer 20260727_admin_access_tower_326.sql d''abord';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.app_modules WHERE module_key = 'stock') THEN
    RAISE EXCEPTION 'navigation #446 : module stock absent du catalogue';
  END IF;
END
$catalog_guard$;

UPDATE public.app_modules
SET
  nav_page_keys = COALESCE(nav_page_keys, ARRAY[]::text[])
    || CASE
      WHEN 'stock-base-old' = ANY (COALESCE(nav_page_keys, ARRAY[]::text[])) THEN ARRAY[]::text[]
      ELSE ARRAY['stock-base-old']
    END
    || CASE
      WHEN 'stock-base-new' = ANY (COALESCE(nav_page_keys, ARRAY[]::text[])) THEN ARRAY[]::text[]
      ELSE ARRAY['stock-base-new']
    END,
  updated_at = now()
WHERE module_key = 'stock'
  AND (
    NOT ('stock-base-old' = ANY (COALESCE(nav_page_keys, ARRAY[]::text[])))
    OR NOT ('stock-base-new' = ANY (COALESCE(nav_page_keys, ARRAY[]::text[])))
  );

COMMIT;
