-- Application rollback keeps the wider numeric columns and the restored view.
-- Narrowing them would permanently round new fractional prices/durations.
-- No data is removed or recalculated. Restore the previous API artifact, then run verify.
DO $$ BEGIN
  IF to_regclass('public.v_production_active_executions') IS NULL THEN
    RAISE EXCEPTION 'Active execution view missing; restore the verified backup';
  END IF;
END $$;
