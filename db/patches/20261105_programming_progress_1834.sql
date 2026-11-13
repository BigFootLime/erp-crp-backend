BEGIN;
ALTER TABLE public.piece_version_programming_tasks
  ADD COLUMN IF NOT EXISTS progress_percent smallint NOT NULL DEFAULT 0;
UPDATE public.piece_version_programming_tasks SET progress_percent=100 WHERE status='DONE' AND progress_percent<>100;
CREATE OR REPLACE FUNCTION public.programming_progress_completion_1834() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='DONE' THEN NEW.progress_percent:=100; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS programming_progress_completion_1834 ON public.piece_version_programming_tasks;
CREATE TRIGGER programming_progress_completion_1834 BEFORE INSERT OR UPDATE OF status,progress_percent
  ON public.piece_version_programming_tasks FOR EACH ROW EXECUTE FUNCTION public.programming_progress_completion_1834();
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.piece_version_programming_tasks'::regclass AND conname='programming_progress_steps_1834') THEN
    ALTER TABLE public.piece_version_programming_tasks ADD CONSTRAINT programming_progress_steps_1834
      CHECK(progress_percent IN (0,25,50,75,100) AND ((status='DONE')=(progress_percent=100)));
  END IF;
END $$;
COMMIT;
