BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.piece_version_programming_tasks WHERE progress_percent IN (25,50,75)) THEN
    RAISE EXCEPTION 'Rollback refused: partial programming progress must be preserved';
  END IF;
END $$;
ALTER TABLE public.piece_version_programming_tasks DROP CONSTRAINT IF EXISTS programming_progress_steps_1834;
DROP TRIGGER IF EXISTS programming_progress_completion_1834 ON public.piece_version_programming_tasks;
DROP FUNCTION IF EXISTS public.programming_progress_completion_1834();
ALTER TABLE public.piece_version_programming_tasks DROP COLUMN IF EXISTS progress_percent;
COMMIT;
