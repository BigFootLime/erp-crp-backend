-- 20260616_fournisseurs_ecosystem.sql
-- Multi-domain supplier ecosystem.
-- Idempotent and additive: preserves gestion_outils_fournisseur numeric IDs.

BEGIN;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping extension pgcrypto (insufficient_privilege)';
END $$;

ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS code_fournisseur text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS raison_sociale text;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS type_principal text NULL;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS status text NULL;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS adresse_ligne text NULL;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS house_no text NULL;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS postcode text NULL;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS city text NULL;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS country text NULL;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS nom_commercial text NULL;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS logo text NULL;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL;

UPDATE public.fournisseurs
SET
  code_fournisseur = COALESCE(code_fournisseur, code),
  raison_sociale = COALESCE(raison_sociale, nom),
  status = COALESCE(status, CASE WHEN actif THEN 'actif' ELSE 'inactif' END),
  country = COALESCE(country, 'France')
WHERE code_fournisseur IS NULL
   OR raison_sociale IS NULL
   OR status IS NULL
   OR country IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseurs_status_chk'
  ) THEN
    ALTER TABLE public.fournisseurs
      ADD CONSTRAINT fournisseurs_status_chk
      CHECK (status IS NULL OR status IN ('actif', 'a_completer', 'inactif', 'archive'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS fournisseurs_type_principal_idx ON public.fournisseurs (type_principal);
CREATE INDEX IF NOT EXISTS fournisseurs_status_idx ON public.fournisseurs (status);
CREATE INDEX IF NOT EXISTS fournisseurs_city_idx ON public.fournisseurs (city);
CREATE INDEX IF NOT EXISTS fournisseurs_archived_at_idx ON public.fournisseurs (archived_at);

ALTER TABLE public.fournisseur_contacts ADD COLUMN IF NOT EXISTS first_name text NULL;
ALTER TABLE public.fournisseur_contacts ADD COLUMN IF NOT EXISTS last_name text NULL;
ALTER TABLE public.fournisseur_contacts ADD COLUMN IF NOT EXISTS full_name text NULL;
ALTER TABLE public.fournisseur_contacts ADD COLUMN IF NOT EXISTS mobile text NULL;
ALTER TABLE public.fournisseur_contacts ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;

UPDATE public.fournisseur_contacts
SET full_name = COALESCE(full_name, nom)
WHERE full_name IS NULL;

CREATE INDEX IF NOT EXISTS fournisseur_contacts_primary_idx
  ON public.fournisseur_contacts (fournisseur_id, is_primary)
  WHERE actif = true;

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

INSERT INTO public.fournisseur_domaines (code, label, description, icon, sort_order, is_active)
VALUES
  ('outillage', 'Outillage', 'Outils coupants, porte-outils, abrasifs, consommables outillage.', 'Wrench', 10, true),
  ('matiere_brute', 'Matière brute', 'Aluminium, acier, inox, plastiques, barres, tôles, bruts sciés.', 'Package', 20, true),
  ('machines_cnc', 'Machines CNC', 'Constructeurs, revendeurs, maintenance et pièces machines.', 'Factory', 30, true),
  ('electrique', 'Électrique', 'Composants, câblage armoire, automatisme, capteurs.', 'Zap', 40, true),
  ('traitements', 'Traitements', 'Anodisation, trempe, nitruration, peinture, zingage, passivation.', 'Layers', 50, true),
  ('informatique', 'Informatique / IT', 'Internet, logiciels, matériel, cybersécurité, cloud, Microsoft 365.', 'Monitor', 60, true),
  ('maintenance', 'Maintenance', 'Interventions, contrats de service et support technique.', 'Settings', 70, true),
  ('transport', 'Transport', 'Transporteurs, messagerie, affrètement et logistique.', 'Truck', 80, true),
  ('sous_traitance', 'Sous-traitance', 'Sous-traitants de production et opérations externalisées.', 'Handshake', 90, true),
  ('metrologie', 'Métrologie', 'Étalonnage, moyens de contrôle et certificats.', 'Ruler', 100, true),
  ('epi', 'EPI', 'Équipements de protection individuelle.', 'Shield', 110, true),
  ('consommables_atelier', 'Consommables atelier', 'Produits et fournitures atelier hors outillage spécifique.', 'Boxes', 120, true),
  ('services_generaux', 'Services généraux', 'Prestataires généraux et support administratif.', 'Building', 130, true),
  ('autre', 'Autres', 'Fournisseurs hors classification principale.', 'Circle', 999, true)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = now();

CREATE TABLE IF NOT EXISTS public.fournisseur_domaine_lien (
  fournisseur_id uuid NOT NULL,
  domaine_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  updated_by integer NULL,
  PRIMARY KEY (fournisseur_id, domaine_id)
);

CREATE INDEX IF NOT EXISTS fournisseur_domaine_lien_domaine_idx
  ON public.fournisseur_domaine_lien (domaine_id);
CREATE UNIQUE INDEX IF NOT EXISTS fournisseur_domaine_lien_primary_uniq
  ON public.fournisseur_domaine_lien (fournisseur_id)
  WHERE is_primary = true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_domaine_lien_fournisseur_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_domaine_lien
      ADD CONSTRAINT fournisseur_domaine_lien_fournisseur_fkey
      FOREIGN KEY (fournisseur_id) REFERENCES public.fournisseurs(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_domaine_lien_domaine_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_domaine_lien
      ADD CONSTRAINT fournisseur_domaine_lien_domaine_fkey
      FOREIGN KEY (domaine_id) REFERENCES public.fournisseur_domaines(id) ON DELETE RESTRICT;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_domaine_lien_created_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_domaine_lien
      ADD CONSTRAINT fournisseur_domaine_lien_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_domaine_lien_updated_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_domaine_lien
      ADD CONSTRAINT fournisseur_domaine_lien_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.fournisseur_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fournisseur_id uuid NOT NULL,
  event_type text NOT NULL,
  title text NOT NULL,
  description text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fournisseur_events_fournisseur_idx
  ON public.fournisseur_events (fournisseur_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fournisseur_events_type_idx
  ON public.fournisseur_events (event_type);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_events_fournisseur_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_events
      ADD CONSTRAINT fournisseur_events_fournisseur_fkey
      FOREIGN KEY (fournisseur_id) REFERENCES public.fournisseurs(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_events_created_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_events
      ADD CONSTRAINT fournisseur_events_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.fournisseur_outillage_mapping (
  fournisseur_id uuid NOT NULL UNIQUE,
  id_fournisseur integer NOT NULL UNIQUE,
  source text NOT NULL DEFAULT 'legacy_outillage',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fournisseur_id, id_fournisseur)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_outillage_mapping_fournisseur_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_outillage_mapping
      ADD CONSTRAINT fournisseur_outillage_mapping_fournisseur_fkey
      FOREIGN KEY (fournisseur_id) REFERENCES public.fournisseurs(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.gestion_outils_fournisseur') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_outillage_mapping_legacy_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_outillage_mapping
      ADD CONSTRAINT fournisseur_outillage_mapping_legacy_fkey
      FOREIGN KEY (id_fournisseur) REFERENCES public.gestion_outils_fournisseur(id_fournisseur) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
DECLARE
  outillage_domain_id uuid;
BEGIN
  SELECT id INTO outillage_domain_id
  FROM public.fournisseur_domaines
  WHERE code = 'outillage';

  IF to_regclass('public.gestion_outils_fournisseur') IS NOT NULL THEN
    INSERT INTO public.fournisseurs (
      code,
      code_fournisseur,
      nom,
      raison_sociale,
      actif,
      email,
      telephone,
      adresse_ligne,
      house_no,
      postcode,
      city,
      country,
      nom_commercial,
      type_principal,
      status,
      notes
    )
    SELECT
      'OUT-' || lpad(g.id_fournisseur::text, 4, '0'),
      'OUT-' || lpad(g.id_fournisseur::text, 4, '0'),
      g.nom,
      g.nom,
      true,
      g.email,
      g.phone_num,
      g.adresse_ligne,
      g.house_no,
      g.postcode,
      g.city,
      COALESCE(NULLIF(g.country, ''), 'France'),
      g.nom_commercial,
      'outillage',
      'actif',
      'Synchronisé depuis gestion_outils_fournisseur.'
    FROM public.gestion_outils_fournisseur g
    WHERE NOT EXISTS (
      SELECT 1 FROM public.fournisseur_outillage_mapping m
      WHERE m.id_fournisseur = g.id_fournisseur
    )
      AND NOT EXISTS (
        SELECT 1
        FROM public.fournisseurs f
        WHERE lower(COALESCE(f.nom, f.raison_sociale, '')) = lower(COALESCE(g.nom, ''))
          AND (
            g.email IS NULL
            OR f.email IS NULL
            OR lower(f.email) = lower(g.email)
          )
      )
    ON CONFLICT (code) DO NOTHING;

    INSERT INTO public.fournisseur_outillage_mapping (fournisseur_id, id_fournisseur, source)
    SELECT resolved.fournisseur_id, g.id_fournisseur, 'legacy_outillage'
    FROM public.gestion_outils_fournisseur g
    LEFT JOIN public.fournisseur_outillage_mapping existing
      ON existing.id_fournisseur = g.id_fournisseur
    CROSS JOIN LATERAL (
      SELECT f.id AS fournisseur_id
      FROM public.fournisseurs f
      WHERE f.code = 'OUT-' || lpad(g.id_fournisseur::text, 4, '0')
         OR (
          lower(COALESCE(f.nom, f.raison_sociale, '')) = lower(COALESCE(g.nom, ''))
          AND (
            g.email IS NULL
            OR f.email IS NULL
            OR lower(f.email) = lower(g.email)
          )
        )
      ORDER BY CASE WHEN f.code = 'OUT-' || lpad(g.id_fournisseur::text, 4, '0') THEN 0 ELSE 1 END, f.created_at
      LIMIT 1
    ) resolved
    WHERE existing.id_fournisseur IS NULL
    ON CONFLICT DO NOTHING;

    INSERT INTO public.fournisseur_domaine_lien (fournisseur_id, domaine_id, is_primary, notes)
    SELECT m.fournisseur_id, outillage_domain_id, true, 'Lien issu du référentiel outillage existant.'
    FROM public.fournisseur_outillage_mapping m
    WHERE outillage_domain_id IS NOT NULL
    ON CONFLICT (fournisseur_id, domaine_id) DO UPDATE SET
      is_primary = EXCLUDED.is_primary,
      notes = COALESCE(public.fournisseur_domaine_lien.notes, EXCLUDED.notes),
      updated_at = now();
  END IF;
END $$;

DO $$
BEGIN
  IF to_regproc('public.tg_set_updated_at()') IS NULL THEN
    RAISE NOTICE 'tg_set_updated_at() not found; skipping fournisseur ecosystem updated_at triggers.';
    RETURN;
  END IF;

  EXECUTE 'DROP TRIGGER IF EXISTS fournisseur_domaines_set_updated_at ON public.fournisseur_domaines';
  EXECUTE 'CREATE TRIGGER fournisseur_domaines_set_updated_at BEFORE UPDATE ON public.fournisseur_domaines FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS fournisseur_domaine_lien_set_updated_at ON public.fournisseur_domaine_lien';
  EXECUTE 'CREATE TRIGGER fournisseur_domaine_lien_set_updated_at BEFORE UPDATE ON public.fournisseur_domaine_lien FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS fournisseur_outillage_mapping_set_updated_at ON public.fournisseur_outillage_mapping';
  EXECUTE 'CREATE TRIGGER fournisseur_outillage_mapping_set_updated_at BEFORE UPDATE ON public.fournisseur_outillage_mapping FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
END $$;

COMMIT;
