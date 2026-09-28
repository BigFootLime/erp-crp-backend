BEGIN;
DO $$ BEGIN IF current_database()<>'cerp_demo' THEN RAISE EXCEPTION 'Demo database required'; END IF; END $$;
INSERT INTO erp_settings(key,value_text,definition,unit,period_start,source,freshness_at,reliability) VALUES('stock.valuation_method','WEIGHTED_AVERAGE','Valorisation du stock fictif de présentation au coût moyen pondéré.','METHOD',CURRENT_DATE,'Configuration déclarée du scénario synthétique CERP+ ; aucune donnée comptable réelle.',now(),'DECLARED') ON CONFLICT(key) DO NOTHING;
INSERT INTO public.currencies(code,name) VALUES('EUR','Euro') ON CONFLICT(code) DO NOTHING;
COMMIT;
