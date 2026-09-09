BEGIN;
SET LOCAL lock_timeout='10s';
ALTER TABLE public.commande_fournisseur_ligne
  ADD COLUMN receipt_stock_managed boolean,
  ADD COLUMN receipt_quality_required boolean,
  ADD COLUMN receipt_consumption_mode text CHECK(receipt_consumption_mode IN('UNIT','GLOBAL_PACK'));
ALTER TABLE public.receptions_fournisseurs
  ADD COLUMN confirmation_state text CHECK(confirmation_state IN('DRAFT','CONFIRMED')),
  ADD COLUMN confirmation_key uuid UNIQUE REFERENCES public.consumable_commands(idempotency_key) DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN confirmed_by integer REFERENCES public.users(id),
  ADD CONSTRAINT supplier_receipt_confirmation_consistent CHECK(
    confirmation_state IS NULL OR
    (confirmation_state='DRAFT' AND confirmation_key IS NULL AND confirmed_at IS NULL AND confirmed_by IS NULL) OR
    (confirmation_state='CONFIRMED' AND confirmation_key IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL));
COMMIT;
