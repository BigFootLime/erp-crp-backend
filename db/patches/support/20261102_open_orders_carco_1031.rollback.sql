\set ON_ERROR_STOP on
DO $$ BEGIN RAISE EXCEPTION 'Retain the additive schema and recorded open orders and deposits when reverting the application'; END $$;
