-- #767: retain previous material configurations once they hold commitments.
BEGIN;
DO $$ DECLARE old_constraint text; BEGIN
  SELECT conname INTO old_constraint FROM pg_constraint WHERE conrelid='public.of_material_needs'::regclass AND contype='u'
    AND pg_get_constraintdef(oid)='UNIQUE (of_id, technical_version_id, source_ref)';
  IF old_constraint IS NULL THEN RAISE EXCEPTION 'Expected material need identity constraint missing'; END IF;
  EXECUTE format('ALTER TABLE public.of_material_needs DROP CONSTRAINT %I',old_constraint);
END $$;
CREATE UNIQUE INDEX of_material_need_current_definition_idx ON public.of_material_needs(of_id,technical_version_id,source_ref) WHERE superseded_at IS NULL;
COMMIT;
