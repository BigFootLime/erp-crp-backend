SELECT current_database(), current_user;
SELECT to_regclass('public.articles'), to_regclass('public.of_material_needs'),
       to_regclass('public.article_category_referential'), to_regclass('public.reception_fournisseur_lignes');
SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid IN ('public.articles'::regclass,'public.article_category_link'::regclass) AND contype='c';
