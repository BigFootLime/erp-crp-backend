-- Verify 20260722_devis_workflow_167 — lecture seule, après application.

-- 1) Colonne position présente et typée integer.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'devis_ligne' AND column_name = 'position';

-- 2) Backfill complet : plus aucune ligne sans position (attendu : 0).
SELECT count(*) AS lignes_sans_position
FROM public.devis_ligne
WHERE position IS NULL;

-- 3) Unicité logique de l'ordre par devis (attendu : 0 doublon).
SELECT devis_id, position, count(*) AS doublons
FROM public.devis_ligne
WHERE position IS NOT NULL
GROUP BY devis_id, position
HAVING count(*) > 1;

-- 4) Table d'idempotence prête (0 ligne au départ) + contrainte d'action.
SELECT to_regclass('public.devis_idempotence') AS devis_idempotence_table;
SELECT count(*) AS idempotence_rows FROM public.devis_idempotence;
SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conrelid = 'public.devis_idempotence'::regclass
ORDER BY conname;

-- 5) Index attendus.
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('devis_ligne_devis_position_idx', 'devis_idempotence_devis_id_idx')
ORDER BY indexname;
