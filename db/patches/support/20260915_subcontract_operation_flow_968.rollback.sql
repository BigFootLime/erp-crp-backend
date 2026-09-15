-- Functional rollback only. Preserve custody, origins, audit and transfer history.
-- After application transfers exist, never downgrade to a backend that ignores their quantities.
BEGIN;
UPDATE public.erp_settings SET value_text='false',freshness_at=now() WHERE key='subcontract.flow_enabled';
UPDATE public.planning_central_settings SET activation='OBSERVE',revision=revision+1,updated_at=clock_timestamp() WHERE singleton;
COMMIT;
-- Re-enable the setting only after diagnosis. Keep this backend deployed to retain quantity
-- guards in Receipts and Production. Never delete receipt or transfer history.
