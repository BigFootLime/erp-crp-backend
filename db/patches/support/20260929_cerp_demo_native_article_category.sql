-- Restore the canonical manufactured category used by the real article form.
-- Only the isolated demonstration database is eligible for this seed repair.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'cerp_demo' THEN RAISE EXCEPTION 'cerp_demo required'; END IF;
END $$;
INSERT INTO public.article_category_ref (code, label, sort_order)
VALUES ('piece_finie_fabriquee', 'Pièce finie / Fabriquée', 10)
ON CONFLICT (code) DO NOTHING;
INSERT INTO public.article_category_referential
  (code,label,code_segment,stock_managed_default,piece_technique_required,commande_client_selectable,is_active,sort_order)
VALUES ('piece_finie_fabriquee','Pièce finie / Fabriquée','PLAN',true,true,true,true,10)
ON CONFLICT (code) DO NOTHING;
COMMIT;
