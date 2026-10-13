-- Restore the previous backend first. Used provenance must be retained.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.production_recovery_material_extensions IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.production_recovery_material_extensions) THEN
    RAISE EXCEPTION 'Retain recovery material history; use a forward correction';
  END IF;
END $$;
DROP TABLE public.production_recovery_material_extensions;
DROP FUNCTION public.fn_recovery_material_extension_1034();
DROP FUNCTION public.fn_recovery_material_extension_allocation_1034();
COMMIT;
