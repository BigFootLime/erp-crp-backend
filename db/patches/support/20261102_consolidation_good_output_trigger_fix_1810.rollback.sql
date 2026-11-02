\set ON_ERROR_STOP on
-- The preceding function has a PostgreSQL NEW-record compilation defect.
-- A forward patch, never a rollback, is the only safe correction.
DO $$ BEGIN
  RAISE EXCEPTION 'Rollback refused: use the forward consolidation trigger correction';
END $$;
