SELECT to_regclass('public.pieces_techniques_achats'),to_regclass('public.article_client_links');
SELECT count(*) AS orders_with_frozen_snapshot FROM public.ordres_fabrication WHERE technical_snapshot_sha256 IS NOT NULL;
SELECT pg_get_functiondef('public.fn_guard_version_purchase_712()'::regprocedure);
