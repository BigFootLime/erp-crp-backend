-- Restore the retained family identities without deleting data or abbreviations.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.surface_finish_families,public.surface_finishes IN SHARE ROW EXCLUSIVE MODE;
DROP TRIGGER IF EXISTS surface_finish_family_code_immutable_1831 ON public.surface_finish_families;
ALTER TABLE public.surface_finish_families DROP CONSTRAINT IF EXISTS surface_finish_families_generated_code_check;
ALTER TABLE public.surface_finish_families ALTER COLUMN code DROP DEFAULT;
UPDATE public.surface_finish_families SET code=legacy_code WHERE legacy_code IS NOT NULL;
-- Retain additive columns and the sequence: later user-created families must not be erased.
COMMIT;
