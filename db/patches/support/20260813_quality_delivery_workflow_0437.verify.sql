SELECT current_database() AS database_name,
       to_regclass('public.quality_delivery_release_policy_event') IS NOT NULL AS has_policy_audit,
       to_regclass('public.quality_delivery_dossier_versions') IS NOT NULL AS has_dossiers,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'quality_control'
           AND column_name = 'delivery_allocation_id'
       ) AS has_allocation_scope,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'bon_livraison_pack_versions'
           AND column_name = 'quality_dossier_version_id'
       ) AS pack_links_dossier;
