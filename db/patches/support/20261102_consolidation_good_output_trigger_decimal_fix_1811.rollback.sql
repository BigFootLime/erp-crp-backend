\set ON_ERROR_STOP on
-- Restoring the prior escaped regex would reject normal decimal values.
DO $$ BEGIN
  RAISE EXCEPTION 'Rollback refused: retain decimal trigger repair or use a reviewed forward migration';
END $$;
