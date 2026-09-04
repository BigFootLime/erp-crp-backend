\set ON_ERROR_STOP on

SELECT current_database() AS database_name, current_user AS database_user;

SELECT to_regclass('public.piece_technique_versions') AS versions_table,
       to_regclass('public.pieces_techniques_nomenclature') AS nomenclature_table,
       to_regclass('public.commande_client') AS commandes_table,
       to_regclass('public.ordres_fabrication') AS ofs_table,
       to_regclass('public.stock_reservations') AS reservations_table,
       to_regclass('public.app_feature_flags') AS feature_flags_table;

SELECT count(*) FILTER (WHERE statut = 'APPLICABLE') AS applicable_versions,
       count(*) AS total_versions
FROM public.piece_technique_versions;
