-- L5: preserve purchase/stock conversion at the time of receipt.
-- Legacy ambiguous conversions remain NULL and require explicit resolution.
BEGIN;
ALTER TABLE public.reception_fournisseur_lignes ADD COLUMN IF NOT EXISTS stock_unit text;
ALTER TABLE public.reception_fournisseur_lignes ADD COLUMN IF NOT EXISTS stock_conversion_coef numeric(20,8) CHECK (stock_conversion_coef>0);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.reception_fournisseur_lignes'::regclass AND conname='reception_stock_conversion_pair_chk') THEN
    ALTER TABLE public.reception_fournisseur_lignes ADD CONSTRAINT reception_stock_conversion_pair_chk CHECK (
      (stock_unit IS NULL AND stock_conversion_coef IS NULL) OR
      (stock_unit IS NOT NULL AND length(trim(stock_unit))>0 AND stock_conversion_coef IS NOT NULL AND stock_conversion_coef>0)
    );
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.preserve_receipt_stock_conversion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.stock_unit IS NOT NULL AND (NEW.stock_unit IS DISTINCT FROM OLD.stock_unit OR NEW.stock_conversion_coef IS DISTINCT FROM OLD.stock_conversion_coef) THEN
    RAISE EXCEPTION 'La conversion figée de cette réception ne peut pas être réécrite.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION public.preserve_receipt_stock_conversion() OWNER TO cerp_app;
CREATE OR REPLACE TRIGGER preserve_receipt_stock_conversion BEFORE UPDATE ON public.reception_fournisseur_lignes
  FOR EACH ROW EXECUTE FUNCTION public.preserve_receipt_stock_conversion();
ALTER TABLE public.reception_fournisseur_stock_receipts ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.reception_fournisseur_stock_receipts ADD COLUMN IF NOT EXISTS request_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS receipt_stock_actor_command_idx ON public.reception_fournisseur_stock_receipts(created_by,idempotency_key) WHERE idempotency_key IS NOT NULL;
COMMIT;
