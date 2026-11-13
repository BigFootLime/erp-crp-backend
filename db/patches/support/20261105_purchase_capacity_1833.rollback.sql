-- Keep every purchase and finish definition. A runtime rollback requires an operator
-- to reconcile any newly created second finish before restoring one-finish indexes.
DO $$ BEGIN RAISE EXCEPTION 'Controlled rollback required: preserve both finish slots and existing purchase identities.'; END $$;
