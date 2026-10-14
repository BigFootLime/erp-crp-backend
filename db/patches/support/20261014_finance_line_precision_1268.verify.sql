DO $$ DECLARE relation text; attribute text; expected_type text; BEGIN
 FOREACH relation IN ARRAY ARRAY['facture_ligne','avoir_ligne'] LOOP
  FOREACH attribute IN ARRAY ARRAY['prix_unitaire_ht','remise_ligne','taux_tva'] LOOP
   expected_type:=CASE attribute WHEN 'prix_unitaire_ht' THEN 'numeric(18,4)' WHEN 'remise_ligne' THEN 'numeric(14,4)' ELSE 'numeric(7,4)' END;
   IF NOT EXISTS(SELECT 1 FROM pg_attribute column_definition WHERE column_definition.attrelid=('public.'||relation)::regclass
     AND column_definition.attname=attribute AND format_type(column_definition.atttypid,column_definition.atttypmod)=expected_type) THEN
    RAISE EXCEPTION 'Finance precision incorrect on %.%',relation,attribute;
   END IF;
  END LOOP;
 END LOOP;
END $$;
SELECT current_database() AS database_name,now() AS verified_at,'Four decimal fiscal line values retained' AS scope;
