SELECT count(*) AS invalid_tasks FROM public.piece_version_programming_tasks
WHERE progress_percent NOT IN (0,25,50,75,100) OR ((status='DONE')<>(progress_percent=100));
SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns
WHERE table_schema='public' AND table_name='piece_version_programming_tasks' AND column_name='progress_percent';
