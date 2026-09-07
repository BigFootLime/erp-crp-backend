-- #767: extend legacy manufacturing-only control contexts to exact typed lots.
-- No business rows change. Validate the replacement before removing the old check.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.quality_control'::regclass AND conname='quality_control_context_v2_chk') THEN
    ALTER TABLE public.quality_control ADD CONSTRAINT quality_control_context_v2_chk CHECK (
      affaire_id IS NOT NULL OR of_id IS NOT NULL OR piece_technique_id IS NOT NULL OR
      COALESCE(source_type='LOT' AND source_id=lot_id::text AND lot_id IS NOT NULL AND article_id IS NOT NULL
        AND plan_id IS NOT NULL AND plan_snapshot_sha256 IS NOT NULL AND qty_population>0,false)
    ) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.quality_control VALIDATE CONSTRAINT quality_control_context_v2_chk;
ALTER TABLE public.quality_control DROP CONSTRAINT IF EXISTS quality_control_context_chk;
COMMIT;
