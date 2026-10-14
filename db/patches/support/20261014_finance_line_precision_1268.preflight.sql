DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['facture_ligne','avoir_ligne'] LOOP
  IF to_regclass('public.'||relation) IS NULL THEN RAISE EXCEPTION 'Finance precision prerequisite missing: %',relation; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_depend dependency JOIN pg_rewrite rewrite ON rewrite.oid=dependency.objid
   JOIN pg_attribute attribute ON attribute.attrelid=dependency.refobjid AND attribute.attnum=dependency.refobjsubid
   WHERE attribute.attrelid IN('public.facture_ligne'::regclass,'public.avoir_ligne'::regclass)
     AND attribute.attname IN('prix_unitaire_ht','remise_ligne','taux_tva')) THEN
  RAISE EXCEPTION 'Finance precision has dependent views; preserve their definitions before migration';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid IN('public.facture_ligne'::regclass,'public.avoir_ligne'::regclass)
   AND tgqual IS NOT NULL AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'Finance precision has conditional triggers; preserve their definitions before migration';
 END IF;
END $$;
SELECT current_database() AS database_name,now() AS preflight_at,'Historical prices and totals retained' AS scope;
