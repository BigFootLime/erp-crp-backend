-- Non-destructive application rollback only: KEEP columns, indexes and all data.
-- Reverting the server code leaves old read payloads functional (the workshop code
-- stays stable). Keep the guard to prevent old clients creating unclassified rows.
-- Do not drop columns: they contain user-entered equivalences. Restore a tested
-- backup only through the separately approved production recovery procedure.
SELECT count(*) AS retained_nuances FROM public.stock_nuances;
