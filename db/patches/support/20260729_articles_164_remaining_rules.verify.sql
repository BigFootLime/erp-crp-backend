-- Issue #164 — vérification lecture seule après application.
-- Les booléens doivent être vrais. Les volumes métier doivent être comparés au
-- préflight : aucune nuance, aucun lot et aucun mouvement ne sont supprimés.

SELECT
  current_database() AS database,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='stock_nuances' AND column_name='densite_kg_m3'
  ) AS col_density_canonical,
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='stock_nuances_density_kg_m3_sync'
      AND NOT tgisinternal
  ) AS trigger_density_sync,
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname='stock_nuances_code_normalized_uq'
  ) AS nuance_code_unique,
  NOT EXISTS (
    SELECT 1 FROM public.stock_nuances
    WHERE densite IS DISTINCT FROM round(densite_kg_m3 / 1000, 6)
  ) AS density_pairs_consistent,
  NOT EXISTS (
    SELECT 1 FROM public.stock_nuances
    WHERE densite_kg_m3 IS NOT NULL
      AND densite_kg_m3 NOT BETWEEN 100 AND 30000
  ) AS density_canonical_range,
  (
    SELECT round(7.85::numeric * 1000, 3) = 7850::numeric
  ) AS conversion_example_7_85_to_7850,
  (
    SELECT COUNT(*) = 7
    FROM public.articles_matiere_families
    WHERE code IN ('PL','RO','U','FOND','TUBE','PROFIL','BRUTCL')
      AND is_active
  ) AS seven_profiles_active,
  NOT EXISTS (
    SELECT 1 FROM public.articles_matiere
    WHERE upper(btrim(family_code)) IN
      ('PLAT','ROND','FONDERI','FONDERIE','PROFI','BRUT-CL','BRUT-CLIENT')
  ) AS legacy_profile_links_normalized,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='articles_matiere'
      AND column_name='client_proprietaire_id'
  ) AS col_material_owner,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='articles_matiere'
      AND column_name='longueur_barre_source_mm'
  ) AS col_source_bar_length,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='articles_matiere'
      AND column_name='longueur_coupe_mm'
  ) AS col_cut_length,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='articles_matiere'
      AND column_name='longueur_brut_mm'
  ) AS col_blank_length,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='articles_matiere'
      AND column_name='quantite_lineaire_totale_mm'
  ) AS col_article_linear_total,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='lots'
      AND column_name='quantite_lineaire_totale_mm'
  ) AS col_lot_linear_total,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='fournisseur_catalogue'
      AND column_name='pricing_basis'
  ) AS col_supplier_pricing_basis,
  NOT EXISTS (
    SELECT 1 FROM public.fournisseur_catalogue
    WHERE pricing_basis NOT IN ('NONE','KG','M')
  ) AS pricing_basis_values_valid,
  (SELECT COUNT(*) FROM public.stock_nuances) AS nuances_after,
  (SELECT COUNT(*) FROM public.articles_matiere) AS material_articles_after,
  (SELECT COUNT(*) FROM public.lots) AS lots_after,
  (SELECT COUNT(*) FROM public.stock_movement_lines) AS movement_lines_after,
  (SELECT COUNT(*) FROM public.fournisseur_catalogue) AS supplier_prices_after;

