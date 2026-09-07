BEGIN READ ONLY;
SELECT current_database() AS database_name,
       has_table_privilege('cerp_app', 'public.stock_lot_trace_references', 'SELECT') AS can_read,
       has_table_privilege('cerp_app', 'public.stock_lot_trace_references', 'INSERT') AS can_insert,
       has_table_privilege('cerp_app', 'public.stock_lot_trace_references', 'DELETE') AS can_replace;
-- Keep the exact previous ACL outside the repository before applying the repair.
SELECT oid::regclass::text AS relation_name, relacl::text AS previous_acl
FROM pg_class WHERE oid = 'public.stock_lot_trace_references'::regclass;
SELECT tgname, tgenabled FROM pg_trigger
WHERE tgrelid = 'public.stock_lot_event_log'::regclass AND NOT tgisinternal;
COMMIT;
