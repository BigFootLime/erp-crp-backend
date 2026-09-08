-- #767 / L3: verification evidence stays attached to the need and lot context.
BEGIN;
ALTER TABLE public.of_material_lot_checks ADD COLUMN IF NOT EXISTS lot_properties_hash text;
ALTER TABLE public.of_material_lot_checks ADD COLUMN IF NOT EXISTS manual_checks_confirmed boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS reception_line_purchase_material_idx ON public.reception_fournisseur_lignes(commande_fournisseur_ligne_id);
COMMIT;
