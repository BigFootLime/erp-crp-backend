-- FLUX-ARTICLES-ACHATS-RECEPTION-20260921
-- Additive: existing article references, lots and purchase orders are preserved.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

INSERT INTO public.articles_matiere_families (code, designation, is_active)
VALUES ('TUBERECT', 'Tube rectangulaire', true),
       ('HEXA', 'Hexagonal', true),
       ('L', 'Profil en L', true)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE public.fournisseur_catalogue
  ADD COLUMN IF NOT EXISTS forfait_ht numeric(18,4),
  ADD COLUMN IF NOT EXISTS minimum_facturation_ht numeric(18,4),
  ADD COLUMN IF NOT EXISTS price_tiers jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.fournisseur_catalogue'::regclass AND conname='fournisseur_catalogue_flow_forfait_check') THEN
    ALTER TABLE public.fournisseur_catalogue ADD CONSTRAINT fournisseur_catalogue_flow_forfait_check CHECK (forfait_ht IS NULL OR forfait_ht >= 0);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.fournisseur_catalogue'::regclass AND conname='fournisseur_catalogue_flow_minimum_check') THEN
    ALTER TABLE public.fournisseur_catalogue ADD CONSTRAINT fournisseur_catalogue_flow_minimum_check CHECK (minimum_facturation_ht IS NULL OR minimum_facturation_ht >= 0);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.fournisseur_catalogue'::regclass AND conname='fournisseur_catalogue_flow_tiers_check') THEN
    ALTER TABLE public.fournisseur_catalogue ADD CONSTRAINT fournisseur_catalogue_flow_tiers_check CHECK (jsonb_typeof(price_tiers) = 'array');
  END IF;
END $$;

ALTER TABLE public.commande_fournisseur_ligne ADD COLUMN IF NOT EXISTS catalogue_pricing_snapshot jsonb;

CREATE TABLE IF NOT EXISTS public.article_subcontract_definition (
  article_id uuid PRIMARY KEY REFERENCES public.articles(id) ON DELETE CASCADE,
  piece_technique_id uuid NOT NULL REFERENCES public.pieces_techniques(id),
  piece_technique_version_id uuid NOT NULL REFERENCES public.piece_technique_versions(id),
  family_label text NOT NULL,
  description text NOT NULL,
  material_provider text NOT NULL CHECK(material_provider IN ('CRP','SUPPLIER')),
  plan_reference text NOT NULL,
  comment text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer
);

-- Keep ownership aligned with the existing application tables, including when
-- the canonical migration runner is invoked by the database administrator.
ALTER TABLE public.article_subcontract_definition OWNER TO cerp_app;

COMMIT;
