-- Restore the guard definition saved by the controlled release operator.
-- Keep linked purchase data and OPERATION rates; dropping them would discard user work.
DO $$ BEGIN RAISE EXCEPTION 'Restore the private before-state guard and OF mode backup through the controlled maintenance operator; do not erase completed dossiers.'; END $$;
