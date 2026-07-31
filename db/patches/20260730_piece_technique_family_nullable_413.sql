-- #413 — une pièce technique / pièce fabriquée ne porte pas de famille métier.
-- Migration additive et idempotente : les liens historiques sont conservés,
-- seules les nouvelles PT peuvent désormais enregistrer famille_id = NULL.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.pieces_techniques') IS NULL THEN
    RAISE EXCEPTION 'Pré-requis absent: public.pieces_techniques';
  END IF;
END $$;

ALTER TABLE public.pieces_techniques
  ALTER COLUMN famille_id DROP NOT NULL;

COMMIT;
