-- Deliberately non-destructive rollback guard for
-- 20260826_zz_historical_stock_imports.sql.
--
-- Historical opening movements, lots and audit evidence must remain readable.
-- Dropping the receipt ledger could make an already posted OLD movement appear
-- untraceable; therefore only an approved forward repair may change it.

BEGIN;

SELECT
  'No automatic rollback: historical import receipts and posted OLD movements are retained. ' ||
  'Use an approved, data-preserving forward repair after reviewing the verify script.' AS notice;

ROLLBACK;
