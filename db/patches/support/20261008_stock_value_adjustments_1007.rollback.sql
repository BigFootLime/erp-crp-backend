-- Manual empty-feature rollback only. Never discard financial evidence.
BEGIN;
SET LOCAL lock_timeout='10s';
LOCK TABLE public.stock_valuation_value_adjustments,public.stock_valuation_entries IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.stock_valuation_value_adjustments)
    OR EXISTS(SELECT 1 FROM public.stock_valuation_entries WHERE value_adjustment_id IS NOT NULL OR kind='VALUE_ADJUSTMENT') THEN
    RAISE EXCEPTION 'Documented financial corrections must be retained; use a forward recovery';
  END IF;
END $$;
DROP TRIGGER stock_value_adjustment_entry_guard ON public.stock_valuation_entries;
ALTER TABLE public.stock_valuation_entries DROP CONSTRAINT stock_value_entry_kind_1007;
ALTER TABLE public.stock_valuation_entries DROP CONSTRAINT stock_value_entry_shape_1007;
ALTER TABLE public.stock_valuation_entries DROP CONSTRAINT stock_value_entry_adjustment_identity_1007;
ALTER TABLE public.stock_valuation_entries DROP CONSTRAINT stock_value_posting_unique_1007;
ALTER TABLE public.stock_valuation_entries ADD CONSTRAINT stock_valuation_entries_kind_check CHECK(
  kind IN('OPENING','RECEIPT','ISSUE','SCRAP','RETURN','RECEIPT_REVERSAL','TRANSFER','ZERO','UNRESOLVED'));
ALTER TABLE public.stock_valuation_entries ADD CONSTRAINT stock_valuation_entries_check CHECK(
  (kind='OPENING' AND movement_id IS NULL AND source_sequence IS NULL)
  OR(kind='UNRESOLVED' AND owner_key IS NULL AND stock_unit IS NULL AND quantity_delta IS NULL
    AND value_delta IS NULL AND movement_value IS NULL AND reliability='UNKNOWN')
  OR(kind='ZERO' AND movement_id IS NOT NULL AND source_sequence IS NOT NULL AND quantity_delta=0 AND value_delta=0 AND movement_value IS NULL)
  OR(kind NOT IN('OPENING','UNRESOLVED','ZERO') AND movement_id IS NOT NULL AND source_sequence IS NOT NULL
    AND owner_key IS NOT NULL AND stock_unit IS NOT NULL AND quantity_delta IS NOT NULL));
ALTER TABLE public.stock_valuation_entries ADD CONSTRAINT stock_valuation_entries_movement_id_article_id_owner_key_stock_u_key
  UNIQUE NULLS NOT DISTINCT(movement_id,article_id,owner_key,stock_unit,currency);
ALTER TABLE public.stock_valuation_entries DROP COLUMN value_adjustment_id;
DROP TABLE public.stock_valuation_value_adjustments;
DROP FUNCTION public.fn_stock_value_adjustment_commit_guard_1007();
DROP FUNCTION public.fn_stock_value_adjustment_entry_guard_1007();
DROP FUNCTION public.fn_stock_value_adjustment_guard_1007();
DROP FUNCTION public.fn_stock_value_candidate_1007(uuid,text);
DROP FUNCTION public.fn_stock_value_physical_1007(uuid,text);
COMMIT;
