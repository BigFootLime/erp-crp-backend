SELECT current_database() AS database_name,
       to_regclass('public.quality_delivery_release_policy') IS NOT NULL AS has_policy,
       to_regclass('public.quality_control') IS NOT NULL AS has_quality_control,
       to_regclass('public.bon_livraison_pack_versions') IS NOT NULL AS has_pack_versions,
       to_regclass('public.bon_livraison_ligne_allocations') IS NOT NULL AS has_allocations;
