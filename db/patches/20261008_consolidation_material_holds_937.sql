-- #937: consolidate physical holds without losing source allocations.
BEGIN;
SET LOCAL lock_timeout='10s';
CREATE TABLE public.production_consolidation_material_holds (
  consolidation_id uuid NOT NULL REFERENCES public.production_consolidations(id) ON DELETE RESTRICT,
  producer_reservation_id uuid NOT NULL REFERENCES public.stock_reservations(id) ON DELETE RESTRICT,
  producer_need_id uuid NOT NULL REFERENCES public.of_material_needs(id) ON DELETE RESTRICT,
  transferred_qty numeric(12,3) NOT NULL CHECK(transferred_qty>=0),
  surplus_qty numeric(12,3) NOT NULL CHECK(surplus_qty>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(consolidation_id,producer_reservation_id),
  CHECK(transferred_qty+surplus_qty>0)
);
CREATE TRIGGER production_consolidation_material_holds_immutable BEFORE UPDATE OR DELETE
  ON public.production_consolidation_material_holds FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
ALTER TABLE public.production_consolidation_material_holds OWNER TO cerp_app;
ALTER TABLE public.production_consolidation_material_transfers
  ADD COLUMN producer_reservation_id uuid,
  ADD COLUMN source_reserved_qty numeric(12,3),
  ADD CONSTRAINT consolidation_material_source_snapshot_937 CHECK(
    (producer_reservation_id IS NULL AND source_reserved_qty IS NULL)
    OR (producer_reservation_id IS NOT NULL AND source_reserved_qty IS NOT NULL AND source_reserved_qty>0)),
  ADD CONSTRAINT consolidation_material_producer_hold_937 FOREIGN KEY(consolidation_id,producer_reservation_id)
    REFERENCES public.production_consolidation_material_holds(consolidation_id,producer_reservation_id) ON DELETE RESTRICT;
-- Existing transfer rows retain their legacy meaning. No invented historical
-- quantity or rewrite of the immutable provenance table.
COMMIT;
