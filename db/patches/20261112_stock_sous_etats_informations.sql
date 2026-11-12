-- Optional explanatory paragraph for material sub-states.
-- Existing rows stay unchanged and can be used without information text.

BEGIN;

ALTER TABLE public.stock_sous_etats
  ADD COLUMN IF NOT EXISTS informations TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'stock_sous_etats_informations_length_check'
      AND conrelid = 'public.stock_sous_etats'::regclass
  ) THEN
    ALTER TABLE public.stock_sous_etats
      ADD CONSTRAINT stock_sous_etats_informations_length_check
      CHECK (informations IS NULL OR char_length(informations) <= 10000);
  END IF;
END $$;

COMMIT;
