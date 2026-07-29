-- Issue #164 — règles Articles / matières / stock encore ouvertes.
--
-- Migration additive et idempotente. Elle prépare la canonisation kg/m³ sans
-- supprimer la colonne historique `stock_nuances.densite` (kg/dm³). Le code
-- applicatif reste compatible avant et après ce patch.
--
-- IMPORTANT : ce fichier est préparé et testé pour cerp_test. Il ne doit pas
-- être appliqué automatiquement à cerp_prod.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.stock_nuances') IS NULL
     OR to_regclass('public.articles') IS NULL
     OR to_regclass('public.articles_matiere') IS NULL
     OR to_regclass('public.articles_matiere_families') IS NULL
     OR to_regclass('public.lots') IS NULL
     OR to_regclass('public.clients') IS NULL
     OR to_regclass('public.fournisseur_catalogue') IS NULL
     OR to_regclass('public.fournisseur_catalogue_prix_history') IS NULL THEN
    RAISE EXCEPTION 'Issue #164 prerequisites are missing';
  END IF;
END
$$;

/* -------------------------------------------------------------------------- */
/* Nuances : code normalisé, désignation facultative, densité canonique kg/m³ */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.stock_nuances
  ALTER COLUMN designation DROP NOT NULL,
  ALTER COLUMN code SET NOT NULL;

ALTER TABLE public.stock_nuances
  ADD COLUMN IF NOT EXISTS densite_kg_m3 numeric(12,3);

UPDATE public.stock_nuances
SET densite_kg_m3 = round(densite * 1000, 3)
WHERE densite_kg_m3 IS NULL
  AND densite IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_stock_nuance_density_kg_m3()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.densite_kg_m3 IS NOT NULL THEN
      NEW.densite := round(NEW.densite_kg_m3 / 1000, 6);
    ELSIF NEW.densite IS NOT NULL THEN
      NEW.densite_kg_m3 := round(NEW.densite * 1000, 3);
    END IF;
  ELSIF NEW.densite_kg_m3 IS DISTINCT FROM OLD.densite_kg_m3 THEN
    NEW.densite := CASE
      WHEN NEW.densite_kg_m3 IS NULL THEN NULL
      ELSE round(NEW.densite_kg_m3 / 1000, 6)
    END;
  ELSIF NEW.densite IS DISTINCT FROM OLD.densite THEN
    NEW.densite_kg_m3 := CASE
      WHEN NEW.densite IS NULL THEN NULL
      ELSE round(NEW.densite * 1000, 3)
    END;
  ELSE
    NEW.densite_kg_m3 := OLD.densite_kg_m3;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS stock_nuances_density_kg_m3_sync ON public.stock_nuances;
CREATE TRIGGER stock_nuances_density_kg_m3_sync
BEFORE INSERT OR UPDATE OF densite, densite_kg_m3 ON public.stock_nuances
FOR EACH ROW EXECUTE FUNCTION public.sync_stock_nuance_density_kg_m3();

CREATE UNIQUE INDEX IF NOT EXISTS stock_nuances_code_normalized_uq
  ON public.stock_nuances (upper(btrim(code)));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_nuances_code_non_blank_check'
      AND conrelid = 'public.stock_nuances'::regclass
  ) THEN
    ALTER TABLE public.stock_nuances
      ADD CONSTRAINT stock_nuances_code_non_blank_check
      CHECK (btrim(code) <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_nuances_density_kg_m3_check'
      AND conrelid = 'public.stock_nuances'::regclass
  ) THEN
    ALTER TABLE public.stock_nuances
      ADD CONSTRAINT stock_nuances_density_kg_m3_check
      CHECK (densite_kg_m3 IS NULL OR densite_kg_m3 BETWEEN 100 AND 30000);
  END IF;
END
$$;

/* -------------------------------------------------------------------------- */
/* Profils matière canoniques. Les anciens codes restent lisibles.            */
/* -------------------------------------------------------------------------- */

INSERT INTO public.articles_matiere_families (code, designation, is_active)
VALUES
  ('PL',     'Plat/Tôle',        true),
  ('RO',     'Rond',             true),
  ('U',      'Profil en U',      true),
  ('FOND',   'Achat fonderie',   true),
  ('TUBE',   'Tube',             true),
  ('PROFIL', 'Profils divers',   true),
  ('BRUTCL', 'Brut client',      true)
ON CONFLICT (code) DO UPDATE
SET designation = EXCLUDED.designation,
    is_active = true,
    updated_at = now();

-- Les anciens codes restent dans le référentiel pour relire l'historique, mais
-- les articles matière existants sont rattachés aux sept profils canoniques.
WITH aliases(legacy_code, canonical_code) AS (
  VALUES
    ('PLAT', 'PL'),
    ('ROND', 'RO'),
    ('FONDERI', 'FOND'),
    ('FONDERIE', 'FOND'),
    ('PROFI', 'PROFIL'),
    ('BRUT-CL', 'BRUTCL'),
    ('BRUT-CLIENT', 'BRUTCL')
)
UPDATE public.articles a
SET family_code = aliases.canonical_code,
    updated_at = now()
FROM public.articles_matiere am, aliases
WHERE am.article_id = a.id
  AND upper(btrim(a.family_code)) = aliases.legacy_code;

WITH aliases(legacy_code, canonical_code) AS (
  VALUES
    ('PLAT', 'PL'),
    ('ROND', 'RO'),
    ('FONDERI', 'FOND'),
    ('FONDERIE', 'FOND'),
    ('PROFI', 'PROFIL'),
    ('BRUT-CL', 'BRUTCL'),
    ('BRUT-CLIENT', 'BRUTCL')
)
UPDATE public.articles_matiere am
SET family_code = aliases.canonical_code,
    updated_at = now()
FROM aliases
WHERE upper(btrim(am.family_code)) = aliases.legacy_code;

/* -------------------------------------------------------------------------- */
/* Dimensions explicites et propriétaire du brut client.                      */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.articles_matiere
  ADD COLUMN IF NOT EXISTS client_proprietaire_id varchar(3),
  ADD COLUMN IF NOT EXISTS longueur_barre_source_mm integer,
  ADD COLUMN IF NOT EXISTS longueur_coupe_mm integer,
  ADD COLUMN IF NOT EXISTS longueur_brut_mm integer,
  ADD COLUMN IF NOT EXISTS quantite_lineaire_totale_mm numeric(18,3);

UPDATE public.articles_matiere
SET longueur_barre_source_mm = longueur_unitaire_mm
WHERE longueur_barre_source_mm IS NULL
  AND barre_a_decouper = true
  AND longueur_unitaire_mm IS NOT NULL;

UPDATE public.articles_matiere
SET longueur_brut_mm = longueur_mm
WHERE longueur_brut_mm IS NULL
  AND longueur_mm IS NOT NULL;

ALTER TABLE public.articles_matiere
  DROP CONSTRAINT IF EXISTS articles_matiere_barre_length_exclusive_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_matiere_remaining_dims_positive_check'
      AND conrelid = 'public.articles_matiere'::regclass
  ) THEN
    ALTER TABLE public.articles_matiere
      ADD CONSTRAINT articles_matiere_remaining_dims_positive_check
      CHECK (
        (longueur_barre_source_mm IS NULL OR longueur_barre_source_mm > 0)
        AND (longueur_coupe_mm IS NULL OR longueur_coupe_mm > 0)
        AND (longueur_brut_mm IS NULL OR longueur_brut_mm > 0)
        AND (quantite_lineaire_totale_mm IS NULL OR quantite_lineaire_totale_mm > 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_matiere_client_proprietaire_fk'
      AND conrelid = 'public.articles_matiere'::regclass
  ) THEN
    ALTER TABLE public.articles_matiere
      ADD CONSTRAINT articles_matiere_client_proprietaire_fk
      FOREIGN KEY (client_proprietaire_id)
      REFERENCES public.clients(client_id)
      ON UPDATE CASCADE
      ON DELETE RESTRICT;
  END IF;
END
$$;

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS quantite_lineaire_totale_mm numeric(18,3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lots_quantite_lineaire_positive_check'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_quantite_lineaire_positive_check
      CHECK (quantite_lineaire_totale_mm IS NULL OR quantite_lineaire_totale_mm > 0);
  END IF;
END
$$;

/* -------------------------------------------------------------------------- */
/* Base de prix fournisseur : aucun / kg / m, sans conversion implicite.       */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.fournisseur_catalogue
  ADD COLUMN IF NOT EXISTS pricing_basis text NOT NULL DEFAULT 'NONE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fournisseur_catalogue_pricing_basis_check'
      AND conrelid = 'public.fournisseur_catalogue'::regclass
  ) THEN
    ALTER TABLE public.fournisseur_catalogue
      ADD CONSTRAINT fournisseur_catalogue_pricing_basis_check
      CHECK (pricing_basis IN ('NONE', 'KG', 'M'));
  END IF;
END
$$;

ALTER TABLE public.fournisseur_catalogue_prix_history
  ADD COLUMN IF NOT EXISTS pricing_basis text NOT NULL DEFAULT 'NONE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fournisseur_catalogue_history_pricing_basis_check'
      AND conrelid = 'public.fournisseur_catalogue_prix_history'::regclass
  ) THEN
    ALTER TABLE public.fournisseur_catalogue_prix_history
      ADD CONSTRAINT fournisseur_catalogue_history_pricing_basis_check
      CHECK (pricing_basis IN ('NONE', 'KG', 'M'));
  END IF;
END
$$;

COMMIT;
