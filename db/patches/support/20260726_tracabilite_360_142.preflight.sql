-- Préflight #142 — LECTURE SEULE. À exécuter AVANT le patch, sur cerp_test.
-- Aucune écriture, aucun verrou long. Objectif : confirmer que les objets
-- attendus existent réellement (« baseliné » ne veut pas dire « exécuté »).

\echo '=== 1. Base cible ==='
SELECT current_database() AS database, current_user AS role, now() AS checked_at;

\echo '=== 2. Tables prérequises (doivent toutes être présentes) ==='
SELECT t AS table_name, (to_regclass('public.' || t) IS NOT NULL) AS present
FROM unnest(ARRAY[
  'users','articles','lots','stock_movements','stock_movement_lines','stock_reservations',
  'ordres_fabrication','of_operations','of_output_lots','of_receipts',
  'reception_fournisseur_lignes','reception_fournisseur_stock_receipts',
  'reception_incoming_inspections','reception_incoming_measurements',
  'bon_livraison','bon_livraison_ligne','bon_livraison_ligne_allocations',
  'bon_livraison_delivery_proofs','quality_control','quality_control_points',
  'quality_release_decision','quality_action','quality_derogation','non_conformity',
  'metrologie_equipements','metrologie_certificats','stock_lot_genealogy_edges',
  'asbuilt_pack_versions','traceability_links','production_pointages'
]) AS t
ORDER BY present, t;

\echo '=== 3. Objets créés par ce patch (doivent être ABSENTS avant application) ==='
SELECT 'of_material_consumptions' AS object,
       (to_regclass('public.of_material_consumptions') IS NOT NULL) AS already_present;
SELECT 'asbuilt_pack_versions.pdf_sha256' AS object,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='asbuilt_pack_versions' AND column_name='pdf_sha256'
       ) AS already_present;

\echo '=== 4. Lignes de mouvement portant un lot ET un article (support de la FK composite) ==='
SELECT COUNT(*) AS lines_with_lot,
       COUNT(*) FILTER (WHERE lot_id IS NULL) AS lines_without_lot
FROM public.stock_movement_lines;

\echo '=== 5. Doublons qui empêcheraient l''index unique (id, article_id, lot_id) ==='
SELECT COUNT(*) AS duplicate_line_keys FROM (
  SELECT id, article_id, lot_id
  FROM public.stock_movement_lines
  WHERE lot_id IS NOT NULL
  GROUP BY id, article_id, lot_id
  HAVING COUNT(*) > 1
) d;

\echo '=== 6. Preuves de consommation matière DÉJÀ disponibles (aucun backfill ne sera fait) ==='
SELECT
  (SELECT COUNT(*) FROM public.stock_reservations
    WHERE of_id IS NOT NULL AND lot_id IS NOT NULL
      AND status = 'CONSUMED' AND consumed_stock_movement_id IS NOT NULL) AS proven_via_reservations,
  (SELECT COUNT(*) FROM public.stock_movements
    WHERE status = 'POSTED' AND source_document_type = 'OF'
      AND source_document_id ~ '^[0-9]{1,18}$') AS declared_via_movements;

\echo '=== 7. Table historique traceability_links (attendue vide : aucun écrivain applicatif) ==='
SELECT COUNT(*) AS legacy_links FROM public.traceability_links;

\echo '=== 8. Extensions utiles ==='
SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','unaccent') ORDER BY extname;

\echo '=== 9. Rôle applicatif ==='
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') AS cerp_app_present;

\echo '=== 10. Volumétrie des tables traversées par le moteur ==='
SELECT relname, n_live_tup
FROM pg_stat_user_tables
WHERE schemaname='public'
  AND relname IN ('lots','stock_movements','stock_movement_lines','ordres_fabrication',
                  'of_output_lots','bon_livraison','bon_livraison_ligne_allocations',
                  'quality_control','non_conformity')
ORDER BY n_live_tup DESC;
