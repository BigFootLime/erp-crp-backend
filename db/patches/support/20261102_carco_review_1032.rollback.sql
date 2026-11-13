\set ON_ERROR_STOP on
-- Business evidence in this patch must survive removal of the client feature.
DO $$ BEGIN RAISE EXCEPTION 'Use the previous application with the additive schema retained, or restore the verified backup'; END $$;
