-- Rollback de 20260708_gpao_achats_type.sql (GPAO B3.5).
-- Retire la catégorie d'achat (type_achat) + son CHECK + son index. Non destructif pour les
-- autres colonnes. À exécuter par un DBA hors du runner db:patches (le runner ne parcourt pas support/).

BEGIN;

DROP INDEX IF EXISTS public.pt_achats_type_achat_idx;

ALTER TABLE public.pieces_techniques_achats
  DROP CONSTRAINT IF EXISTS pt_achats_type_achat_check;

ALTER TABLE public.pieces_techniques_achats
  DROP COLUMN IF EXISTS type_achat;

COMMIT;
