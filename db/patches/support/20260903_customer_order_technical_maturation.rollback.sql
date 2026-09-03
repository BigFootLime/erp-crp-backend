-- Rollback structurel réservé aux environnements sans nouvelles données #698.
BEGIN;
DROP TABLE IF EXISTS public.commande_quick_piece_idempotence;
DROP INDEX IF EXISTS public.ordres_fabrication_technical_queue_idx;
DROP INDEX IF EXISTS public.affaire_delivery_readiness_idx;
DROP INDEX IF EXISTS public.affaire_parent_affaire_idx;
UPDATE public.affaire tranche
SET parent_affaire_id = NULL
FROM public.affaire principale
WHERE tranche.parent_affaire_id = principale.id
  AND principale.is_principal
  AND principale.reference = 'AFF-MERE-' || principale.commande_id::text;
DELETE FROM public.commande_to_affaire lien
USING public.affaire principale
WHERE lien.affaire_id = principale.id
  AND principale.is_principal
  AND principale.reference = 'AFF-MERE-' || principale.commande_id::text;
DELETE FROM public.affaire principale
WHERE principale.is_principal
  AND principale.reference = 'AFF-MERE-' || principale.commande_id::text;
ALTER TABLE public.ordres_fabrication
  DROP CONSTRAINT IF EXISTS ordres_fabrication_technical_validated_by_fkey,
  DROP CONSTRAINT IF EXISTS ordres_fabrication_technical_submitted_by_fkey,
  DROP CONSTRAINT IF EXISTS ordres_fabrication_technical_readiness_check,
  DROP COLUMN IF EXISTS technical_validated_by,
  DROP COLUMN IF EXISTS technical_validated_at,
  DROP COLUMN IF EXISTS technical_submitted_by,
  DROP COLUMN IF EXISTS technical_submitted_at,
  DROP COLUMN IF EXISTS technical_preparation,
  DROP COLUMN IF EXISTS technical_readiness;
ALTER TABLE public.affaire
  DROP CONSTRAINT IF EXISTS affaire_parent_affaire_id_fkey,
  DROP CONSTRAINT IF EXISTS affaire_delivery_readiness_state_check,
  DROP COLUMN IF EXISTS parent_affaire_id,
  DROP COLUMN IF EXISTS delivery_readiness_state;
COMMIT;
