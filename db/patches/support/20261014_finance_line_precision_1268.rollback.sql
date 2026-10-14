BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ DECLARE relation text; would_lose_value boolean; BEGIN
 IF current_database()<>'cerp_test' AND current_setting('cerp.rollback_ack',true) IS DISTINCT FROM '1268-empty-model-reviewed' THEN
  RAISE EXCEPTION 'Finance precision rollback requires explicit reviewed acknowledgement';
 END IF;
 FOREACH relation IN ARRAY ARRAY['facture_ligne','avoir_ligne'] LOOP
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE prix_unitaire_ht<>round(prix_unitaire_ht,2)
    OR remise_ligne<>round(remise_ligne,2) OR taux_tva<>round(taux_tva,2) OR abs(prix_unitaire_ht)>=10000000000)',relation) INTO would_lose_value;
  IF would_lose_value THEN RAISE EXCEPTION 'Finance precision rollback refused: % contains saved four-decimal values',relation; END IF;
 END LOOP;
END $$;
ALTER TABLE public.facture_ligne ALTER COLUMN prix_unitaire_ht TYPE numeric(12,2),ALTER COLUMN remise_ligne TYPE numeric(12,2),ALTER COLUMN taux_tva TYPE numeric(5,2);
ALTER TABLE public.avoir_ligne ALTER COLUMN prix_unitaire_ht TYPE numeric(12,2),ALTER COLUMN remise_ligne TYPE numeric(12,2),ALTER COLUMN taux_tva TYPE numeric(5,2);
COMMIT;
