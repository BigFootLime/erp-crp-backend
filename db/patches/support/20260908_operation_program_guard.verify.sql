\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT current_database(),current_user;
SELECT tgrelid::regclass,tgname,tgenabled FROM pg_trigger WHERE tgfoid='public.fn_guard_preparation_execution_712()'::regprocedure ORDER BY 1;
SELECT pg_get_functiondef('public.fn_guard_preparation_execution_712()'::regprocedure) LIKE '%operation_kind%' AS scoped,
pg_get_functiondef('public.fn_guard_preparation_execution_712()'::regprocedure) LIKE '%OF_PROGRAMMING_REQUIRED%' AS machining_guard_kept,
pg_get_functiondef('public.fn_guard_preparation_execution_712()'::regprocedure) LIKE '%self_inspection_sheet_id%' AS preparation_guard_kept;
COMMIT;
