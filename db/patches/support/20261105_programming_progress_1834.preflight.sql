-- Lecture seule. Confirmer séparément la sauvegarde et l’environnement avant application.
SELECT current_database() AS database_name,current_user AS database_role;
SELECT to_regclass('public.piece_version_programming_tasks') AS target_table;
SELECT column_name,data_type,is_nullable FROM information_schema.columns
WHERE table_schema='public' AND table_name='piece_version_programming_tasks'
  AND column_name IN ('status','program_reference','completed_at','completed_by','progress_percent');
SELECT status,count(*) FROM public.piece_version_programming_tasks GROUP BY status;
SELECT count(*) AS invalid_completed_tasks FROM public.piece_version_programming_tasks
WHERE status='DONE' AND (NULLIF(btrim(program_reference),'') IS NULL OR completed_at IS NULL OR completed_by IS NULL);
