-- #413 — lecture seule après application.
SELECT
  is_nullable = 'YES' AS famille_id_nullable,
  data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'pieces_techniques'
  AND column_name = 'famille_id';

SELECT
  count(*) AS total_pieces_techniques,
  count(*) FILTER (WHERE famille_id IS NULL) AS sans_famille,
  count(*) FILTER (WHERE famille_id IS NOT NULL) AS historiques_avec_famille
FROM public.pieces_techniques;

SELECT
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.pieces_techniques'::regclass
      AND contype = 'f'
      AND pg_get_constraintdef(oid) ILIKE '%famille_id%'
  ) AS foreign_key_preserved;
