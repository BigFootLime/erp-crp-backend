SELECT current_database() AS database_name,
       pg_get_functiondef('public.fn_next_issued_code_value(text)'::regprocedure) AS allocator_before,
       to_regclass('public.cerp_business_code_issue_seq') AS sequence;
