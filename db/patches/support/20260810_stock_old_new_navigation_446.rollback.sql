-- Rollback de recette uniquement — raccourcis Stock OLD/NEW #446.
\set ON_ERROR_STOP on

DO $rollback_guard$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'navigation #446 rollback refused hors cerp_test (base actuelle : %)', current_database();
  END IF;
END
$rollback_guard$;

BEGIN;

UPDATE public.app_modules
SET
  nav_page_keys = array_remove(
    array_remove(COALESCE(nav_page_keys, ARRAY[]::text[]), 'stock-base-old'),
    'stock-base-new'
  ),
  updated_at = now()
WHERE module_key = 'stock';

COMMIT;
