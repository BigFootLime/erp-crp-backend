-- Non-destructive rollback: restore the previous API/frontend artefact.
-- Retain this additive table and its migration ledger entry so personal settings survive.
-- No schema removal or user-data deletion is required.
SELECT current_database() AS rollback_database, to_regclass('public.user_navigation_preferences') AS retained_table;
