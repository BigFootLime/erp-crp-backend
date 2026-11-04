SELECT count(*) AS families FROM public.surface_finish_families;
SELECT count(*) AS finishes FROM public.surface_finishes;
SELECT count(*) AS articles FROM public.articles_traitement;
SELECT conrelid::regclass AS child_table,conname,pg_get_constraintdef(oid)
FROM pg_constraint WHERE contype='f' AND confrelid='public.surface_finish_families'::regclass;
