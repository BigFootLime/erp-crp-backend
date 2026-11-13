-- Restore the two function definitions and trigger definition saved in the private release backup.
-- Retain material/PS links and their audit history; do not drop columns or delete purchase rows.
DO $$ BEGIN RAISE EXCEPTION 'Use the controlled rollback with the saved function and trigger definitions; preserve completed links.'; END $$;
