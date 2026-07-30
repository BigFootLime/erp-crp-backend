-- #413 — lecture seule avant application.
SELECT current_database() AS database, current_user AS role, now() AS checked_at;

DO $$
BEGIN
  IF to_regclass('public.pieces_techniques') IS NULL THEN
    RAISE EXCEPTION 'Pré-vol #413 impossible : public.pieces_techniques est absente';
  END IF;
END
$$;

SELECT
  table_schema,
  table_name,
  column_name,
  is_nullable,
  data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'pieces_techniques'
  AND column_name = 'famille_id';

SELECT
  count(*) AS total_pieces_techniques,
  count(*) FILTER (WHERE famille_id IS NULL) AS sans_famille,
  count(*) FILTER (WHERE famille_id IS NOT NULL) AS avec_famille
FROM public.pieces_techniques;
