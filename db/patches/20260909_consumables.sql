-- #1047: additive consumable policy. Existing articles retain quality checks.
BEGIN;
ALTER TABLE public.articles
  ADD COLUMN IF NOT EXISTS internal_reference text,
  ADD COLUMN IF NOT EXISTS consumption_mode text NOT NULL DEFAULT 'UNIT',
  ADD COLUMN IF NOT EXISTS purchase_pack_qty numeric(14,3) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS receipt_quality_required boolean NOT NULL DEFAULT true;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='articles_consumption_policy_check' AND conrelid='public.articles'::regclass) THEN
    ALTER TABLE public.articles ADD CONSTRAINT articles_consumption_policy_check CHECK (
      consumption_mode IN ('UNIT','GLOBAL_PACK') AND purchase_pack_qty > 0
      AND (consumption_mode <> 'GLOBAL_PACK' OR (stock_managed AND lot_tracking))
    );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS articles_internal_reference_idx ON public.articles(lower(internal_reference)) WHERE internal_reference IS NOT NULL;
INSERT INTO public.article_category_ref(code,label,is_active,sort_order)
VALUES('consommable','Consommable',true,45) ON CONFLICT(code) DO NOTHING;
INSERT INTO public.article_category_referential
  (code,label,code_segment,stock_managed_default,piece_technique_required,commande_client_selectable,is_active,sort_order)
VALUES('consommable','Consommable','ACH',true,false,false,true,45) ON CONFLICT(code) DO NOTHING;
INSERT INTO public.articles_achat_families(code,designation)
VALUES('CONS','Consommables') ON CONFLICT(code) DO NOTHING;
ALTER TABLE public.pieces_techniques_achats DROP CONSTRAINT IF EXISTS pt_achats_type_achat_check;
ALTER TABLE public.pieces_techniques_achats ADD CONSTRAINT pt_achats_type_achat_check CHECK(type_achat IN
  ('MATIERE','CONSOMMABLE','VISSERIE','COMPOSANT_CATALOGUE','TRAITEMENT','SOUS_TRAITANCE','CERTIFICAT','DIVERS'));
-- Each tracked package has its own canonical lot. Supplier lot codes may repeat.
ALTER TABLE public.lots ADD COLUMN IF NOT EXISTS is_consumable_pack boolean NOT NULL DEFAULT false;
ALTER TABLE public.of_material_needs
  ADD COLUMN IF NOT EXISTS need_kind text NOT NULL DEFAULT 'MATIERE',
  ADD COLUMN IF NOT EXISTS consumption_mode text NOT NULL DEFAULT 'UNIT',
  ADD COLUMN IF NOT EXISTS stock_managed boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS receipt_quality_required boolean NOT NULL DEFAULT true;
-- Reception acceptance is a frozen policy, not a later re-reading of the article.
ALTER TABLE public.reception_fournisseur_lignes
  ADD COLUMN IF NOT EXISTS receipt_quality_required boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS stock_managed boolean NOT NULL DEFAULT true;
COMMIT;
