-- Keep immutable evidence and all native objects after an application rollback.
-- Never remove imported stock/orders or reset a counter in an ordinary update.
SELECT current_database() AS database_name,'KEEP_RECEIPTS_AND_NATIVE_DATA' AS rollback_action;
