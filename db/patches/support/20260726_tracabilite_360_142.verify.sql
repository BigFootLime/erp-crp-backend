-- Vérification #142 — LECTURE SEULE. À exécuter APRÈS le patch.
-- Toute ligne `ok = false` doit bloquer la suite (et interdit toute
-- proposition de production).

\echo '=== 1. Table de consommation matière ==='
SELECT 'of_material_consumptions exists' AS check,
       (to_regclass('public.of_material_consumptions') IS NOT NULL) AS ok;

\echo '=== 2. Colonnes attendues ==='
SELECT c AS column_name,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='of_material_consumptions' AND column_name=c
       ) AS ok
FROM unnest(ARRAY[
  'id','of_id','of_operation_id','article_id','lot_id','stock_movement_id',
  'stock_movement_line_id','reservation_id','qty','unit_code','effective_at',
  'status','source','compensates_id','compensated_by_id','correlation_id',
  'idempotency_key','created_at','created_by'
]) AS c
ORDER BY ok, c;

\echo '=== 3. Contraintes de cohérence ==='
SELECT conname, (conname IS NOT NULL) AS ok, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.of_material_consumptions'::regclass
ORDER BY conname;

\echo '=== 4. Idempotence : une ligne de mouvement = une consommation ==='
SELECT 'of_material_consumptions_line_uq' AS check,
       EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname='public' AND indexname='of_material_consumptions_line_uq'
       ) AS ok;

\echo '=== 5. Trigger append-only ==='
SELECT 'trg_protect_of_material_consumption' AS check,
       EXISTS (
         SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'public.of_material_consumptions'::regclass
           AND tgname = 'trg_protect_of_material_consumption'
           AND NOT tgisinternal
       ) AS ok;

\echo '=== 6. Index de traçabilité créés ==='
SELECT i AS index_name,
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=i) AS ok
FROM unnest(ARRAY[
  'stock_movements_source_document_idx',
  'stock_reservations_of_consumed_idx',
  'reception_fournisseur_stock_receipts_line_idx',
  'of_operations_of_idx',
  'production_pointages_operation_idx',
  'bon_livraison_ligne_bl_idx',
  'quality_release_decision_control_idx',
  'quality_derogation_lot_idx',
  'metrologie_certificats_equipement_date_idx',
  'lots_lot_code_lower_idx',
  'ordres_fabrication_numero_lower_idx',
  'articles_code_lower_idx',
  'bon_livraison_numero_lower_idx',
  'of_material_consumptions_of_idx',
  'of_material_consumptions_lot_idx'
]) AS i
ORDER BY ok, i;

\echo '=== 7. Durcissement as-built ==='
SELECT c AS column_name,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='asbuilt_pack_versions' AND column_name=c
       ) AS ok
FROM unnest(ARRAY['pdf_sha256','pdf_size_bytes','as_of','scope_json','revoked_at','revoked_by','revocation_reason','superseded_by_id']) AS c
ORDER BY ok, c;

\echo '=== 8. Ownership et droits du rôle applicatif ==='
SELECT tablename, tableowner,
       (tableowner = 'cerp_app') AS ok
FROM pg_tables
WHERE schemaname='public' AND tablename = 'of_material_consumptions';

\echo '=== 9. Lecture effective par cerp_app ==='
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
    EXECUTE 'SET LOCAL ROLE cerp_app';
    PERFORM COUNT(*) FROM public.of_material_consumptions;
    RESET ROLE;
    RAISE NOTICE 'cerp_app can read of_material_consumptions: OK';
  ELSE
    RAISE NOTICE 'Role cerp_app absent: read check skipped';
  END IF;
END $$;

\echo '=== 10. AUCUN backfill déduit n''a été inséré (doit valoir 0) ==='
SELECT COUNT(*) AS rows_inserted_by_patch FROM public.of_material_consumptions;
