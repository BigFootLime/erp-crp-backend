-- Issue #164 — préflight lecture seule.
-- Tous les booléens `req_*` et `safe_*` doivent être vrais avant application.

SELECT
  current_database() AS database,
  to_regclass('public.stock_nuances') IS NOT NULL AS req_stock_nuances,
  to_regclass('public.articles') IS NOT NULL AS req_articles,
  to_regclass('public.articles_matiere') IS NOT NULL AS req_articles_matiere,
  to_regclass('public.articles_matiere_families') IS NOT NULL AS req_matiere_families,
  to_regclass('public.lots') IS NOT NULL AS req_lots,
  to_regclass('public.clients') IS NOT NULL AS req_clients,
  to_regclass('public.fournisseur_catalogue') IS NOT NULL AS req_supplier_catalogue,
  to_regclass('public.fournisseur_catalogue_prix_history') IS NOT NULL AS req_supplier_price_history,
  NOT EXISTS (
    SELECT 1
    FROM public.stock_nuances
    WHERE code IS NULL OR btrim(code) = ''
  ) AS safe_nuance_codes_present,
  NOT EXISTS (
    SELECT 1
    FROM public.stock_nuances
    GROUP BY upper(btrim(code))
    HAVING COUNT(*) > 1
  ) AS safe_nuance_codes_unique,
  NOT EXISTS (
    SELECT 1
    FROM public.stock_nuances
    WHERE densite IS NOT NULL
      AND densite NOT BETWEEN 0.1 AND 30
  ) AS safe_legacy_density_range,
  (SELECT COUNT(*) FROM public.stock_nuances) AS nuances_before,
  (SELECT COUNT(*) FROM public.stock_nuances WHERE designation IS NULL) AS nuances_without_designation_before,
  (SELECT COUNT(*) FROM public.stock_nuances WHERE densite IS NOT NULL) AS densities_to_convert,
  (SELECT COUNT(*) FROM public.articles_matiere) AS material_articles_before,
  (SELECT COUNT(*) FROM public.lots) AS lots_before,
  (SELECT COUNT(*) FROM public.stock_movement_lines) AS movement_lines_before,
  (SELECT COUNT(*) FROM public.fournisseur_catalogue) AS supplier_prices_before,
  (
    SELECT jsonb_object_agg(family_code, row_count)
    FROM (
      SELECT family_code, COUNT(*) AS row_count
      FROM public.articles_matiere
      GROUP BY family_code
      ORDER BY family_code
    ) counts
  ) AS material_profiles_before;

