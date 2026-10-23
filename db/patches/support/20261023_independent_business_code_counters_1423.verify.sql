-- Read-only: verification must never reserve business numbers.
BEGIN READ ONLY;
SELECT position('nextval(v_sequence)' IN prosrc)>0 AS uses_scope_sequence,
       position('cerp_business_code_issue_seq' IN prosrc)=0 AS shared_allocator_retired
FROM pg_proc WHERE oid='public.fn_next_issued_code_value(text)'::regprocedure;
SELECT obj_description(c.oid,'pg_class') AS scope,s.last_value,s.max_value,s.cycle
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_sequences s ON s.schemaname=n.nspname AND s.sequencename=c.relname
WHERE c.relkind='S' AND c.relname LIKE 'cerp_code_issue_%'
ORDER BY scope;
SELECT count(*)=count(DISTINCT obj_description(c.oid,'pg_class')) AS sequences_have_distinct_scopes,
       bool_and(c.relname='cerp_code_issue_' || md5(replace(obj_description(c.oid,'pg_class'),'Business-code scope: ','')) || '_seq') AS scope_mapping_matches
FROM pg_class c WHERE c.relkind='S' AND c.relname LIKE 'cerp_code_issue_%';
ROLLBACK;
