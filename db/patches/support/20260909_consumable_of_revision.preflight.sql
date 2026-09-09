SELECT current_database(),current_user;
SELECT to_regclass('public.of_revisions'),to_regclass('public.of_material_needs');
SELECT of_id,count(*) FROM public.of_revisions WHERE statut='ACTIVE' GROUP BY of_id HAVING count(*)>1;
SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='of_material_needs' AND column_name='of_revision_id';
