-- Stock sub-states are standalone referential values. Existing rows retain
-- their historical state link, while new rows no longer require one.
-- Safe to run after 20260331_stock_matiere_premiere_referentials.sql.

BEGIN;

ALTER TABLE public.stock_sous_etats
  ALTER COLUMN etat_id DROP NOT NULL;

-- Preserve historical links and their per-state uniqueness. New standalone
-- values have a unique code without rewriting existing rows.
CREATE UNIQUE INDEX IF NOT EXISTS stock_sous_etats_standalone_code_uniq
  ON public.stock_sous_etats (code)
  WHERE etat_id IS NULL;

COMMIT;
