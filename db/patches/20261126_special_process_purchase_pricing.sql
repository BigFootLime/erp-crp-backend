BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.pieces_techniques_achats
  ADD COLUMN forfait_ht numeric(14,2),
  ADD COLUMN minimum_facturation_ht numeric(14,2),
  ADD CONSTRAINT pt_achats_traitement_facturation_ck CHECK (
    (forfait_ht IS NULL AND minimum_facturation_ht IS NULL) OR
    (type_achat = 'TRAITEMENT' AND (
      (forfait_ht BETWEEN 0 AND 9999999.99 AND minimum_facturation_ht IS NULL AND prix IS NULL AND pu_achat IS NULL) OR
      (forfait_ht IS NULL AND minimum_facturation_ht BETWEEN 0 AND 9999999.99 AND (prix IS NOT NULL OR pu_achat IS NOT NULL))
    ))
  ) NOT VALID;

ALTER TABLE public.pieces_techniques_achats VALIDATE CONSTRAINT pt_achats_traitement_facturation_ck;
COMMIT;
