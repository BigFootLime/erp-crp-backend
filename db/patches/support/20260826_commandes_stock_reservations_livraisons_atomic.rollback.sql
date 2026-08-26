-- Deliberately non-destructive rollback guard for
-- 20260826_commandes_stock_reservations_livraisons_atomic.sql.
--
-- This patch introduces audit/ledger traceability (receipts, stock corrections
-- and shipment idempotency).  Dropping it would erase business evidence and
-- invalidate posted movement links.  A rollback therefore requires an
-- approved, data-preserving migration designed from the exact deployment data.
-- This support file is intentionally safe to execute and changes nothing.

BEGIN;

SELECT
  'No automatic rollback: preserve stock/reservation/delivery traceability. ' ||
  'Prepare an approved forward repair or an archival migration instead.' AS notice;

ROLLBACK;
