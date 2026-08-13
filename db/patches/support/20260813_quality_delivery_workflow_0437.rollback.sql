-- Rollback structurel uniquement pour environnement isole, apres suppression
-- explicite des donnees creees par le patch.
BEGIN;
ALTER TABLE public.bon_livraison_pack_versions DROP CONSTRAINT IF EXISTS bon_livraison_pack_quality_dossier_0437_fk;
ALTER TABLE public.bon_livraison_pack_versions DROP COLUMN IF EXISTS quality_dossier_version_id;
DROP TABLE IF EXISTS public.quality_delivery_dossier_versions;
ALTER TABLE public.quality_control DROP CONSTRAINT IF EXISTS quality_control_delivery_release_scope_0437_ck;
ALTER TABLE public.quality_control DROP CONSTRAINT IF EXISTS quality_control_delivery_allocation_0437_fk;
ALTER TABLE public.quality_control DROP COLUMN IF EXISTS delivery_allocation_id;
DROP TABLE IF EXISTS public.quality_delivery_release_policy_event;
DROP INDEX IF EXISTS public.quality_delivery_release_policy_one_active_0437_uq;
COMMIT;
