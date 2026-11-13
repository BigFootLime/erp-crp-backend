-- A material sub-state is a standalone referential value. Existing rows keep
-- their historical state association; new entries may have no state.
-- This avoids rewriting data and keeps existing per-state duplicates valid.

BEGIN;

ALTER TABLE public.stock_sous_etats ALTER COLUMN etat_id DROP NOT NULL;

-- Keep the existing FK for non-null historical links. It permits NULL values.
-- The existing (etat_id, code) index remains unchanged for linked historical
-- entries. PostgreSQL considers NULL values distinct, so add a narrow partial
-- index to prevent duplicate standalone codes without rewriting that index.
CREATE UNIQUE INDEX IF NOT EXISTS stock_sous_etats_standalone_code_uniq
  ON public.stock_sous_etats (code)
  WHERE etat_id IS NULL;

COMMIT;
