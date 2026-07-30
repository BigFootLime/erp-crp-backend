-- #413 — rollback contrôlé.
-- Refuse de rétablir NOT NULL si des PT sans famille ont déjà été créées.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.pieces_techniques
    WHERE famille_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Rollback #413 impossible: des pièces techniques sans famille existent';
  END IF;
END $$;

ALTER TABLE public.pieces_techniques
  ALTER COLUMN famille_id SET NOT NULL;

COMMIT;
