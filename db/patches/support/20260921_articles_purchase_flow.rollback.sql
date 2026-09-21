-- Functional rollback: redeploy the preceding API/web/mobile artifacts.
-- Retain the additive schema and every business record created after deployment.
-- This script deliberately makes no database changes and does not remove ledger entries.
BEGIN READ ONLY;
SELECT 'Redeploy the preceding application artifacts; retain the additive schema and business data' AS rollback_action;
COMMIT;
