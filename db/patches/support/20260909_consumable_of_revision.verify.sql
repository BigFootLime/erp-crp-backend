SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='of_material_needs' AND column_name='of_revision_id';
SELECT count(*) AS invalid_revision_owner FROM public.of_material_needs n JOIN public.of_revisions r ON r.id=n.of_revision_id WHERE n.of_id<>r.of_id;
SELECT conname,convalidated FROM pg_constraint WHERE conrelid='public.of_material_needs'::regclass AND conname LIKE '%of_revision%';
