-- 20260721_fournisseurs_360.rollback.sql
--
-- Guarded, NON-DESTRUCTIVE rollback of db/patches/20260721_fournisseurs_360.sql.
-- Refuses to drop objects that still hold data; only removes structures added by the
-- patch. Never touches base-table rows and keeps the seeded currencies (harmless).
-- Manual only (not part of db:patches:up).
--
--   sudo -u postgres psql -d cerp_test -f db/patches/support/20260721_fournisseurs_360.rollback.sql

BEGIN;

-- 1) Refuse if any of the new tables still contain rows.
DO $$
DECLARE total bigint := 0;
BEGIN
  IF to_regclass('public.fournisseur_catalogue_prix_history') IS NOT NULL THEN
    total := total + (SELECT count(*) FROM public.fournisseur_catalogue_prix_history);
  END IF;
  IF to_regclass('public.fournisseur_homologations') IS NOT NULL THEN
    total := total + (SELECT count(*) FROM public.fournisseur_homologations);
  END IF;
  IF to_regclass('public.fournisseur_adresses') IS NOT NULL THEN
    total := total + (SELECT count(*) FROM public.fournisseur_adresses);
  END IF;

  IF total > 0 THEN
    RAISE EXCEPTION '#163 rollback refused: new tables still hold % row(s). Empty them deliberately before rolling back.', total;
  END IF;
END $$;

-- 2) Drop the new tables (empty at this point). Cascades their own indexes/triggers.
DROP TABLE IF EXISTS public.fournisseur_catalogue_prix_history;
DROP TABLE IF EXISTS public.fournisseur_homologations;
DROP TABLE IF EXISTS public.fournisseur_adresses;

-- 3) Remove the catalogue enrichment columns only if they hold no data.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.fournisseur_catalogue
    WHERE incoterm IS NOT NULL
       OR prix_multiple IS NOT NULL
       OR valid_from IS NOT NULL
       OR valid_to IS NOT NULL
       OR exigence_qualite IS NOT NULL
       OR requiert_controle_reception = true
  ) THEN
    RAISE NOTICE '#163 rollback: catalogue enrichment columns hold data — keeping them (non-destructive).';
  ELSE
    ALTER TABLE public.fournisseur_catalogue DROP CONSTRAINT IF EXISTS fournisseur_catalogue_incoterm_check;
    ALTER TABLE public.fournisseur_catalogue DROP CONSTRAINT IF EXISTS fournisseur_catalogue_multiple_nonneg_chk;
    ALTER TABLE public.fournisseur_catalogue DROP CONSTRAINT IF EXISTS fournisseur_catalogue_validity_chk;
    ALTER TABLE public.fournisseur_catalogue DROP CONSTRAINT IF EXISTS fournisseur_catalogue_devise_fkey;
    ALTER TABLE public.fournisseur_catalogue DROP COLUMN IF EXISTS incoterm;
    ALTER TABLE public.fournisseur_catalogue DROP COLUMN IF EXISTS prix_multiple;
    ALTER TABLE public.fournisseur_catalogue DROP COLUMN IF EXISTS valid_from;
    ALTER TABLE public.fournisseur_catalogue DROP COLUMN IF EXISTS valid_to;
    ALTER TABLE public.fournisseur_catalogue DROP COLUMN IF EXISTS exigence_qualite;
    ALTER TABLE public.fournisseur_catalogue DROP COLUMN IF EXISTS requiert_controle_reception;
  END IF;
END $$;

-- 4) Drop the indexes added on existing tables.
DROP INDEX IF EXISTS public.fournisseur_catalogue_valid_to_idx;
DROP INDEX IF EXISTS public.fournisseurs_siret_norm_uniq;
DROP INDEX IF EXISTS public.fournisseurs_siret_norm_idx;
DROP INDEX IF EXISTS public.fournisseurs_tva_norm_uniq;
DROP INDEX IF EXISTS public.fournisseurs_tva_norm_idx;

COMMIT;
