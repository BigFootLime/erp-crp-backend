-- #404 — famille interne des pièces techniques fabriquées.
-- Additif, idempotent, sans réécriture des pièces historiques.
-- La colonne pieces_techniques.famille_id reste NOT NULL ; les nouvelles PT
-- reçoivent la famille référentielle PF côté serveur.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.pieces_families') IS NULL THEN
    RAISE EXCEPTION 'Pré-requis absent: public.pieces_families';
  END IF;
END $$;

INSERT INTO public.pieces_families (code, designation)
SELECT 'PF', 'Pièce fabriquée (interne)'
WHERE NOT EXISTS (
  SELECT 1
  FROM public.pieces_families
  WHERE upper(btrim(code)) = 'PF'
);

COMMIT;
