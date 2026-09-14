-- Fail closed: rolling back the stock protection would re-enable premature IN.
-- Keep this additive schema and all ledgers. Roll the UI forward to a compatible
-- version, pause receipt writes, and use the recovery runbook. No automatic DDL,
-- historical recategorization, ledger deletion or fabricated packaging evidence.
DO $$ BEGIN RAISE EXCEPTION 'No destructive rollback for #1069. Keep the stock guards; follow docs/runbooks/receipt-processing-1069.md'; END $$;
