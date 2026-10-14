-- Match the fiscal workflow's four-decimal prices and percentages.
-- Widening preserves every historical value; no price or total is recalculated.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.facture_ligne
 ALTER COLUMN prix_unitaire_ht TYPE numeric(18,4) USING prix_unitaire_ht::numeric(18,4),
 ALTER COLUMN remise_ligne TYPE numeric(14,4) USING remise_ligne::numeric(14,4),
 ALTER COLUMN taux_tva TYPE numeric(7,4) USING taux_tva::numeric(7,4);
ALTER TABLE public.avoir_ligne
 ALTER COLUMN prix_unitaire_ht TYPE numeric(18,4) USING prix_unitaire_ht::numeric(18,4),
 ALTER COLUMN remise_ligne TYPE numeric(14,4) USING remise_ligne::numeric(14,4),
 ALTER COLUMN taux_tva TYPE numeric(7,4) USING taux_tva::numeric(7,4);
COMMIT;
