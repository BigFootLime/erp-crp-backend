BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.pieces_techniques_operations ADD COLUMN IF NOT EXISTS prix_vente_horaire numeric(14,4) NULL;
ALTER TABLE public.pieces_techniques_operations ADD CONSTRAINT operation_prix_vente_horaire_positive CHECK(prix_vente_horaire IS NULL OR prix_vente_horaire>=0);
COMMENT ON COLUMN public.pieces_techniques_operations.prix_vente_horaire IS 'Optional operation selling rate, expressed in the operation currency per hour. NULL is unknown, independent from its cost rate and from the part selling price.';
COMMIT;
