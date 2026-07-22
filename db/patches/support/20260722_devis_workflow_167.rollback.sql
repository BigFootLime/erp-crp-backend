-- Rollback 20260722_devis_workflow_167.
-- Retire uniquement ce que le patch a ajouté. La perte de position/idempotence est
-- acceptée en retour arrière (le code retombe sur l'ordre id ASC et l'absence de rejeu).

BEGIN;

DROP INDEX IF EXISTS public.devis_idempotence_devis_id_idx;
DROP TABLE IF EXISTS public.devis_idempotence;

DROP INDEX IF EXISTS public.devis_ligne_devis_position_idx;
ALTER TABLE public.devis_ligne DROP CONSTRAINT IF EXISTS devis_ligne_position_positive;
ALTER TABLE public.devis_ligne DROP COLUMN IF EXISTS position;

COMMIT;
