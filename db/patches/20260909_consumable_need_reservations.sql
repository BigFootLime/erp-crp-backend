BEGIN;
SET LOCAL lock_timeout='10s';
-- A frozen OF may use one article/lot on several distinct BOM needs. Preserve
-- legacy uniqueness while retaining each new need's independent reservation.
CREATE UNIQUE INDEX stock_reservations_active_legacy_source_lot_uq
  ON public.stock_reservations(source_type,source_id,article_id,location_id,lot_id)
  WHERE status='ACTIVE' AND lot_id IS NOT NULL AND material_need_id IS NULL;
CREATE UNIQUE INDEX stock_reservations_active_need_lot_uq
  ON public.stock_reservations(material_need_id,article_id,location_id,lot_id)
  WHERE status='ACTIVE' AND lot_id IS NOT NULL AND material_need_id IS NOT NULL;
DROP INDEX public.stock_reservations_active_source_lot_uq;
ALTER TABLE public.reception_fournisseur_lignes
  ADD COLUMN destination_magasin_id uuid REFERENCES public.magasins(id),
  ADD COLUMN destination_emplacement_id bigint REFERENCES public.emplacements(id),
  ADD CONSTRAINT reception_destination_pair CHECK((destination_magasin_id IS NULL)=(destination_emplacement_id IS NULL));
COMMIT;
