-- 20260616_fournisseurs_ecosystem.sql
-- Fournisseurs ecosystem fields, domains and activity timeline.
-- Idempotent patch: safe to run multiple times.

BEGIN;

ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS code_fournisseur text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS raison_sociale text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'actif';
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS type_principal text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS adresse_ligne text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS house_no text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS postcode text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS nom_commercial text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS logo text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS archived_at timestamptz;

UPDATE public.fournisseurs
SET
  code_fournisseur = COALESCE(code_fournisseur, code),
  raison_sociale = COALESCE(raison_sociale, nom),
  status = CASE
    WHEN archived_at IS NOT NULL THEN 'archive'
    WHEN actif = false THEN 'inactif'
    WHEN status IS NULL THEN 'actif'
    ELSE status
  END;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseurs_status_check'
  ) THEN
    ALTER TABLE public.fournisseurs
      ADD CONSTRAINT fournisseurs_status_check
      CHECK (status IN ('actif','a_completer','inactif','archive'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS fournisseurs_status_idx ON public.fournisseurs (status);
CREATE INDEX IF NOT EXISTS fournisseurs_type_principal_idx ON public.fournisseurs (type_principal);
CREATE INDEX IF NOT EXISTS fournisseurs_city_idx ON public.fournisseurs (city);

ALTER TABLE public.fournisseur_contacts ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE public.fournisseur_contacts ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE public.fournisseur_contacts ADD COLUMN IF NOT EXISTS full_name text;
ALTER TABLE public.fournisseur_contacts ADD COLUMN IF NOT EXISTS mobile text;
ALTER TABLE public.fournisseur_contacts ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;

UPDATE public.fournisseur_contacts
SET full_name = COALESCE(full_name, nom);

CREATE UNIQUE INDEX IF NOT EXISTS fournisseur_contacts_one_primary_idx
  ON public.fournisseur_contacts (fournisseur_id)
  WHERE is_primary = true AND actif = true;

CREATE TABLE IF NOT EXISTS public.fournisseur_domaines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  description text NULL,
  icon text NULL,
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.fournisseur_domaines (code, label, icon, sort_order)
VALUES
  ('outillage', 'Outillage', 'Wrench', 10),
  ('matiere_brute', 'Matière brute', 'Package', 20),
  ('machines_cnc', 'Machines CNC', 'Factory', 30),
  ('electrique', 'Électrique', 'Zap', 40),
  ('traitements', 'Traitements', 'Layers', 50),
  ('informatique', 'Informatique / IT', 'Monitor', 60),
  ('maintenance', 'Maintenance', 'Settings', 70),
  ('transport', 'Transport', 'Truck', 80),
  ('sous_traitance', 'Sous-traitance', 'Handshake', 90),
  ('metrologie', 'Métrologie', 'Ruler', 100),
  ('epi', 'EPI', 'Shield', 110),
  ('consommables_atelier', 'Consommables atelier', 'Boxes', 120),
  ('services_generaux', 'Services généraux', 'Building', 130),
  ('autre', 'Autres', 'Circle', 999)
ON CONFLICT (code) DO UPDATE
SET label = EXCLUDED.label,
    icon = EXCLUDED.icon,
    sort_order = EXCLUDED.sort_order,
    is_active = true,
    updated_at = now();

CREATE TABLE IF NOT EXISTS public.fournisseur_domaine_lien (
  fournisseur_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE CASCADE,
  domaine_code text NOT NULL REFERENCES public.fournisseur_domaines(code) ON DELETE RESTRICT,
  is_primary boolean NOT NULL DEFAULT false,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  updated_by integer NULL,
  PRIMARY KEY (fournisseur_id, domaine_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS fournisseur_domaine_one_primary_idx
  ON public.fournisseur_domaine_lien (fournisseur_id)
  WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS fournisseur_domaine_lien_code_idx
  ON public.fournisseur_domaine_lien (domaine_code);

CREATE TABLE IF NOT EXISTS public.fournisseur_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fournisseur_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  title text NOT NULL,
  description text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fournisseur_events_fournisseur_idx
  ON public.fournisseur_events (fournisseur_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.fournisseur_outillage_mapping (
  fournisseur_id uuid PRIMARY KEY REFERENCES public.fournisseurs(id) ON DELETE CASCADE,
  id_fournisseur integer NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  updated_by integer NULL
);

DO $$
BEGIN
  IF to_regclass('public.gestion_outils_fournisseur') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_outillage_mapping_legacy_fkey'
    )
  THEN
    ALTER TABLE public.fournisseur_outillage_mapping
      ADD CONSTRAINT fournisseur_outillage_mapping_legacy_fkey
      FOREIGN KEY (id_fournisseur)
      REFERENCES public.gestion_outils_fournisseur(id_fournisseur)
      ON DELETE RESTRICT;
  END IF;
END $$;

COMMIT;
