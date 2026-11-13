-- Compare these counts with the preflight. No historical row/link should disappear.
SELECT count(*) AS nuances, count(*) FILTER (WHERE designation_principale='LEGACY') AS to_classify FROM public.stock_nuances;
SELECT count(*) AS article_links FROM public.articles_matiere WHERE nuance_id IS NOT NULL;
SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'stock_nuances_library_%' ORDER BY indexname;
SELECT count(*) AS orphan_links FROM public.articles_matiere am LEFT JOIN public.stock_nuances n ON n.id=am.nuance_id WHERE am.nuance_id IS NOT NULL AND n.id IS NULL;
