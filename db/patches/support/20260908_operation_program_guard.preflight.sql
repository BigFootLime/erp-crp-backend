\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT current_database(),current_user;
SELECT 'public.of_dossier_validations'::regclass,'public.production_pointages'::regclass;
SELECT phase,designation,f.value->>'type_operation' AS operation_kind
FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id
CROSS JOIN LATERAL jsonb_array_elements(o.technical_snapshot->'operations') f
WHERE f.value->>'phase'=op.phase::text LIMIT 0;
SELECT pg_get_functiondef('public.fn_guard_preparation_execution_712()'::regprocedure);
COMMIT;
