-- Extend the existing immutable demand history; no order or stock is created.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.production_purchase_preparations DROP CONSTRAINT production_purchase_preparations_kind_check;
ALTER TABLE public.production_purchase_preparations ADD CONSTRAINT production_purchase_preparations_kind_check
    CHECK(kind IN ('MATIERE','CONSOMMABLE','PRESTATION'));
COMMIT;
