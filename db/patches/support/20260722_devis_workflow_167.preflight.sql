-- Preflight 20260722_devis_workflow_167 — lecture seule.
-- À exécuter AVANT le patch pour figer l'état de départ.

-- 1) Tables cibles présentes ?
SELECT
  to_regclass('public.devis')             AS devis_table,
  to_regclass('public.devis_ligne')       AS devis_ligne_table,
  to_regclass('public.devis_idempotence') AS devis_idempotence_table;

-- 2) Colonne position déjà là ? (attendu avant patch : 0 ligne)
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'devis_ligne' AND column_name = 'position';

-- 3) Volumétrie devis_ligne (pour jauger le backfill).
SELECT count(*) AS devis_ligne_rows,
       count(DISTINCT devis_id) AS devis_avec_lignes
FROM public.devis_ligne;

-- 4) Contrainte / index homonymes préexistants ? (attendu : 0 ligne)
SELECT conname FROM pg_constraint
WHERE conname IN ('devis_ligne_position_positive')
  AND conrelid = 'public.devis_ligne'::regclass;
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('devis_ligne_devis_position_idx', 'devis_idempotence_devis_id_idx');
