-- Retain purchasing evidence. Use the previous application against the additive
-- schema or restore the separately verified backup to a new database.
DO $$ BEGIN RAISE EXCEPTION 'Treatment command evidence must be retained'; END $$;
