-- Roll back code first. Preserve all financial proof tables/functions.
-- Refuse shape rollback if a real correction exists; never delete its evidence.
BEGIN;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtextextended('stock:cump-projector:1',0));
SELECT singleton FROM public.stock_valuation_projector_control WHERE singleton FOR UPDATE;
LOCK TABLE public.stock_valuation_movement_journal IN SHARE MODE;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.stock_valuation_invoice_reconciliations)
 OR EXISTS(SELECT 1 FROM public.stock_valuation_entries WHERE kind='INVOICE_ADJUSTMENT') THEN
 RAISE EXCEPTION 'A sourced correction exists; preserve ledger and use a forward financial correction'; END IF; END $$;
ALTER TABLE public.stock_valuation_entries DROP CONSTRAINT stock_invoice_entry_kind_1022,
 DROP CONSTRAINT stock_invoice_entry_shape_1022, DROP CONSTRAINT stock_invoice_posting_unique_1022;
ALTER TABLE public.stock_valuation_entries ADD CONSTRAINT stock_value_entry_kind_1007 CHECK(
 kind IN('OPENING','RECEIPT','ISSUE','SCRAP','RETURN','RECEIPT_REVERSAL','TRANSFER','ZERO','UNRESOLVED','VALUE_ADJUSTMENT'));
ALTER TABLE public.stock_valuation_entries ADD CONSTRAINT stock_value_entry_shape_1007 CHECK(
 (kind='OPENING' AND movement_id IS NULL AND source_sequence IS NULL)
 OR(kind='UNRESOLVED' AND owner_key IS NULL AND stock_unit IS NULL AND quantity_delta IS NULL
 AND value_delta IS NULL AND movement_value IS NULL AND reliability='UNKNOWN')
 OR(kind='ZERO' AND movement_id IS NOT NULL AND source_sequence IS NOT NULL AND quantity_delta=0 AND value_delta=0 AND movement_value IS NULL)
 OR(kind='VALUE_ADJUSTMENT' AND movement_id IS NULL AND source_sequence IS NOT NULL AND source_sequence>=0 AND owner_key='COMPANY' AND currency='EUR'
 AND stock_unit IS NOT NULL AND quantity_delta=0 AND reliability='DECLARED' AND value_adjustment_id IS NOT NULL)
 OR(kind NOT IN('OPENING','UNRESOLVED','ZERO','VALUE_ADJUSTMENT') AND movement_id IS NOT NULL AND source_sequence IS NOT NULL
 AND owner_key IS NOT NULL AND stock_unit IS NOT NULL AND quantity_delta IS NOT NULL));
ALTER TABLE public.stock_valuation_entries ADD CONSTRAINT stock_value_posting_unique_1007
 UNIQUE NULLS NOT DISTINCT(movement_id,article_id,owner_key,stock_unit,currency,value_adjustment_id);
COMMIT;
