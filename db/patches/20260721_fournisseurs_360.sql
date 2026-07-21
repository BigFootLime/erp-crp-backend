-- 20260721_fournisseurs_360.sql
-- Issue #163 — Fournisseur 360.
-- Additive, idempotent completion of the supplier reference model:
--   * typed addresses (commande / livraison / facturation) with one primary per type,
--   * structured supplier homologation/qualification (status + validity + versioning),
--   * catalogue enrichment (incoterm, price validity, order multiple, quality requirement)
--     + optional FK to the currencies referential + a price/lead-time history table,
--   * normalized SIRET/TVA uniqueness (legacy-safe: falls back to a non-unique index
--     when duplicates already exist so the patch never hard-fails on legacy data).
--
-- SOURCE OF TRUTH (unchanged): public.fournisseurs (UUID) is canonical; the legacy
-- outillage tables (public.gestion_outils_fournisseur*) stay intact and are linked only
-- through public.fournisseur_outillage_mapping. This patch adds NO new master table and
-- rewrites NO history.
--
-- Compatibility columns (code/code_fournisseur, nom/raison_sociale, contacts nom/full_name,
-- and the flat address columns on public.fournisseurs) are NORMALIZED by the service layer
-- through a single write path — this patch does not duplicate-write them.
--
-- Safe to run multiple times. Application role: cerp_app (no ownership/grant changes here).
-- Support scripts (run manually, NOT picked up by db:patches:up):
--   db/patches/support/20260721_fournisseurs_360.preflight.sql  (read-only, BEFORE apply)
--   db/patches/support/20260721_fournisseurs_360.verify.sql     (read-only, AFTER apply)
--   db/patches/support/20260721_fournisseurs_360.rollback.sql   (guarded, non-destructive)

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Guard: the canonical supplier table must already exist                  */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.fournisseurs') IS NULL THEN
    RAISE EXCEPTION '#163: public.fournisseurs is missing — apply 20260225_fournisseurs_catalogue.sql and 20260616_fournisseurs_ecosystem.sql first';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Reference data: a few common currencies so the catalogue FK is usable   */
/*    (public.currencies(code PK, name) already exists — seed is additive)    */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.currencies') IS NOT NULL THEN
    INSERT INTO public.currencies (code, name) VALUES
      ('EUR', 'Euro'),
      ('USD', 'Dollar US'),
      ('GBP', 'Livre sterling'),
      ('CHF', 'Franc suisse')
    ON CONFLICT (code) DO NOTHING;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2) Catalogue enrichment                                                    */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.fournisseur_catalogue ADD COLUMN IF NOT EXISTS incoterm text;
ALTER TABLE public.fournisseur_catalogue ADD COLUMN IF NOT EXISTS prix_multiple numeric(12, 3);
ALTER TABLE public.fournisseur_catalogue ADD COLUMN IF NOT EXISTS valid_from date;
ALTER TABLE public.fournisseur_catalogue ADD COLUMN IF NOT EXISTS valid_to date;
ALTER TABLE public.fournisseur_catalogue ADD COLUMN IF NOT EXISTS exigence_qualite text;
ALTER TABLE public.fournisseur_catalogue ADD COLUMN IF NOT EXISTS requiert_controle_reception boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  -- Incoterms 2020 (nullable).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_catalogue_incoterm_check') THEN
    ALTER TABLE public.fournisseur_catalogue
      ADD CONSTRAINT fournisseur_catalogue_incoterm_check
      CHECK (incoterm IS NULL OR incoterm IN
        ('EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP'));
  END IF;

  -- Non-negative multiple.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_catalogue_multiple_nonneg_chk') THEN
    ALTER TABLE public.fournisseur_catalogue
      ADD CONSTRAINT fournisseur_catalogue_multiple_nonneg_chk
      CHECK (prix_multiple IS NULL OR prix_multiple >= 0);
  END IF;

  -- Coherent validity window.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_catalogue_validity_chk') THEN
    ALTER TABLE public.fournisseur_catalogue
      ADD CONSTRAINT fournisseur_catalogue_validity_chk
      CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from);
  END IF;

  -- Optional FK devise -> currencies(code); only if the referential exists AND no
  -- existing catalogue row has a devise that is absent from currencies (legacy-safe).
  IF to_regclass('public.currencies') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_catalogue_devise_fkey')
    AND NOT EXISTS (
      SELECT 1 FROM public.fournisseur_catalogue fc
      LEFT JOIN public.currencies c ON c.code = fc.devise
      WHERE fc.devise IS NOT NULL AND fc.devise <> '' AND c.code IS NULL
    )
  THEN
    ALTER TABLE public.fournisseur_catalogue
      ADD CONSTRAINT fournisseur_catalogue_devise_fkey
      FOREIGN KEY (devise) REFERENCES public.currencies(code) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS fournisseur_catalogue_valid_to_idx
  ON public.fournisseur_catalogue (valid_to) WHERE valid_to IS NOT NULL;

/* -------------------------------------------------------------------------- */
/* 3) Catalogue price / lead-time history                                     */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.fournisseur_catalogue_prix_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalogue_id uuid NOT NULL REFERENCES public.fournisseur_catalogue(id) ON DELETE CASCADE,
  prix_unitaire numeric(12, 3) NULL,
  devise text NULL,
  delai_jours integer NULL,
  moq numeric(12, 3) NULL,
  valid_from date NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by integer NULL,
  CONSTRAINT fournisseur_catalogue_prix_history_nonneg_chk CHECK (
    (prix_unitaire IS NULL OR prix_unitaire >= 0)
    AND (moq IS NULL OR moq >= 0)
    AND (delai_jours IS NULL OR delai_jours >= 0)
  )
);

CREATE INDEX IF NOT EXISTS fournisseur_catalogue_prix_history_catalogue_idx
  ON public.fournisseur_catalogue_prix_history (catalogue_id, recorded_at DESC);

DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_catalogue_prix_history_recorded_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_catalogue_prix_history
      ADD CONSTRAINT fournisseur_catalogue_prix_history_recorded_by_fkey
      FOREIGN KEY (recorded_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 4) Typed addresses (commande / livraison / facturation)                    */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.fournisseur_adresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fournisseur_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE CASCADE,
  type text NOT NULL,
  label text NULL,
  ligne1 text NULL,
  ligne2 text NULL,
  house_no text NULL,
  postcode text NULL,
  city text NULL,
  country text NULL,
  is_primary boolean NOT NULL DEFAULT false,
  actif boolean NOT NULL DEFAULT true,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  updated_by integer NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_adresses_type_check') THEN
    ALTER TABLE public.fournisseur_adresses
      ADD CONSTRAINT fournisseur_adresses_type_check
      CHECK (type IN ('commande','livraison','facturation'));
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_adresses_created_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_adresses
      ADD CONSTRAINT fournisseur_adresses_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_adresses_updated_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_adresses
      ADD CONSTRAINT fournisseur_adresses_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- One primary address per (supplier, type) among active rows.
CREATE UNIQUE INDEX IF NOT EXISTS fournisseur_adresses_one_primary_per_type_idx
  ON public.fournisseur_adresses (fournisseur_id, type)
  WHERE is_primary = true AND actif = true;

CREATE INDEX IF NOT EXISTS fournisseur_adresses_fournisseur_idx
  ON public.fournisseur_adresses (fournisseur_id);
CREATE INDEX IF NOT EXISTS fournisseur_adresses_type_idx
  ON public.fournisseur_adresses (type);

/* -------------------------------------------------------------------------- */
/* 5) Structured homologation / qualification (status + validity + versioning)*/
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.fournisseur_homologations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fournisseur_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE CASCADE,
  domaine_code text NULL REFERENCES public.fournisseur_domaines(code) ON DELETE RESTRICT,
  statut text NOT NULL DEFAULT 'a_qualifier',
  reference text NULL,
  organisme text NULL,
  perimetre text NULL,
  valid_from date NULL,
  valid_to date NULL,
  document_id uuid NULL REFERENCES public.fournisseur_documents(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1,
  is_current boolean NOT NULL DEFAULT true,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  updated_by integer NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_homologations_statut_check') THEN
    ALTER TABLE public.fournisseur_homologations
      ADD CONSTRAINT fournisseur_homologations_statut_check
      CHECK (statut IN ('a_qualifier','en_cours','homologue','sous_reserve','suspendu','refuse','expire'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_homologations_validity_chk') THEN
    ALTER TABLE public.fournisseur_homologations
      ADD CONSTRAINT fournisseur_homologations_validity_chk
      CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_homologations_version_chk') THEN
    ALTER TABLE public.fournisseur_homologations
      ADD CONSTRAINT fournisseur_homologations_version_chk
      CHECK (version >= 1);
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_homologations_created_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_homologations
      ADD CONSTRAINT fournisseur_homologations_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_homologations_updated_by_fkey'
  ) THEN
    ALTER TABLE public.fournisseur_homologations
      ADD CONSTRAINT fournisseur_homologations_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Exactly one current homologation per (supplier, domain). A NULL domain (global
-- homologation) is folded to '' so at most one global-current row is allowed too.
CREATE UNIQUE INDEX IF NOT EXISTS fournisseur_homologations_one_current_idx
  ON public.fournisseur_homologations (fournisseur_id, COALESCE(domaine_code, ''))
  WHERE is_current = true;

CREATE INDEX IF NOT EXISTS fournisseur_homologations_fournisseur_idx
  ON public.fournisseur_homologations (fournisseur_id);
CREATE INDEX IF NOT EXISTS fournisseur_homologations_valid_to_idx
  ON public.fournisseur_homologations (valid_to) WHERE valid_to IS NOT NULL;

/* -------------------------------------------------------------------------- */
/* 6) Normalized SIRET / TVA uniqueness (legacy-safe)                         */
/*    Digits/letters only, upper-cased. If duplicates already exist, we create */
/*    a NON-unique index and RAISE NOTICE instead of failing the patch.       */
/* -------------------------------------------------------------------------- */

DO $$
DECLARE dup_groups integer;
BEGIN
  SELECT count(*) INTO dup_groups FROM (
    SELECT regexp_replace(upper(siret), '[^0-9A-Z]', '', 'g') AS n
    FROM public.fournisseurs
    WHERE siret IS NOT NULL AND btrim(siret) <> ''
    GROUP BY 1
    HAVING count(*) > 1
  ) d;

  IF dup_groups = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS fournisseurs_siret_norm_uniq
      ON public.fournisseurs (regexp_replace(upper(siret), '[^0-9A-Z]', '', 'g'))
      WHERE siret IS NOT NULL AND btrim(siret) <> '';
  ELSE
    RAISE NOTICE '#163: % duplicate normalized SIRET group(s) present — creating non-unique index; dedup before enforcing uniqueness', dup_groups;
    CREATE INDEX IF NOT EXISTS fournisseurs_siret_norm_idx
      ON public.fournisseurs (regexp_replace(upper(siret), '[^0-9A-Z]', '', 'g'))
      WHERE siret IS NOT NULL AND btrim(siret) <> '';
  END IF;
END $$;

DO $$
DECLARE dup_groups integer;
BEGIN
  SELECT count(*) INTO dup_groups FROM (
    SELECT regexp_replace(upper(tva), '[^0-9A-Z]', '', 'g') AS n
    FROM public.fournisseurs
    WHERE tva IS NOT NULL AND btrim(tva) <> ''
    GROUP BY 1
    HAVING count(*) > 1
  ) d;

  IF dup_groups = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS fournisseurs_tva_norm_uniq
      ON public.fournisseurs (regexp_replace(upper(tva), '[^0-9A-Z]', '', 'g'))
      WHERE tva IS NOT NULL AND btrim(tva) <> '';
  ELSE
    RAISE NOTICE '#163: % duplicate normalized TVA group(s) present — creating non-unique index; dedup before enforcing uniqueness', dup_groups;
    CREATE INDEX IF NOT EXISTS fournisseurs_tva_norm_idx
      ON public.fournisseurs (regexp_replace(upper(tva), '[^0-9A-Z]', '', 'g'))
      WHERE tva IS NOT NULL AND btrim(tva) <> '';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 7) updated_at triggers for the new tables (optional helper)                */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regproc('public.tg_set_updated_at()') IS NULL THEN
    RAISE NOTICE '#163: tg_set_updated_at() not found; skipping updated_at triggers.';
    RETURN;
  END IF;

  EXECUTE 'DROP TRIGGER IF EXISTS fournisseur_adresses_set_updated_at ON public.fournisseur_adresses';
  EXECUTE 'CREATE TRIGGER fournisseur_adresses_set_updated_at BEFORE UPDATE ON public.fournisseur_adresses FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS fournisseur_homologations_set_updated_at ON public.fournisseur_homologations';
  EXECUTE 'CREATE TRIGGER fournisseur_homologations_set_updated_at BEFORE UPDATE ON public.fournisseur_homologations FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
END $$;

COMMIT;
