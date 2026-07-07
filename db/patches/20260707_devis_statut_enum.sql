-- 20260707_devis_statut_enum.sql
--
-- Purpose
-- - Enforce a canonical devis.statut enum: BROUILLON / ENVOYE / ACCEPTE / REFUSE / EXPIRE / ANNULE.
-- - Normalize any legacy value (lowercase / accented / EN aliases) to the canonical form.
--
-- Safety
-- - Idempotent (safe to run multiple times).
-- - Non-destructive: only normalizes text values + swaps a CHECK constraint. No data loss.
--   (devis table is currently empty on cerp_prod/cerp_test, so the UPDATEs are no-ops today.)
--
-- Target DB: PostgreSQL

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.devis') IS NULL THEN
    RAISE NOTICE 'Skipping: public.devis missing';
    RETURN;
  END IF;

  -- 1) Normalize known legacy values to the canonical enum.
  UPDATE public.devis d SET statut = m.canon
  FROM (VALUES
    ('brouillon','BROUILLON'), ('draft','BROUILLON'),
    ('envoye','ENVOYE'), ('envoyé','ENVOYE'), ('sent','ENVOYE'), ('a_relancer','ENVOYE'),
    ('accepte','ACCEPTE'), ('accepté','ACCEPTE'), ('acceptee','ACCEPTE'), ('acceptée','ACCEPTE'), ('accepted','ACCEPTE'),
    ('refuse','REFUSE'), ('refusé','REFUSE'), ('refusee','REFUSE'), ('refusée','REFUSE'), ('rejected','REFUSE'),
    ('expire','EXPIRE'), ('expiré','EXPIRE'), ('expiree','EXPIRE'), ('expirée','EXPIRE'), ('expired','EXPIRE'),
    ('annule','ANNULE'), ('annulé','ANNULE'), ('annulee','ANNULE'), ('annulée','ANNULE'), ('cancelled','ANNULE'), ('canceled','ANNULE')
  ) AS m(src, canon)
  WHERE lower(btrim(d.statut)) = m.src;

  -- 2) Any remaining non-canonical value -> BROUILLON (safe default).
  UPDATE public.devis
  SET statut = 'BROUILLON'
  WHERE statut IS NULL
     OR statut NOT IN ('BROUILLON','ENVOYE','ACCEPTE','REFUSE','EXPIRE','ANNULE');

  -- 3) Default + CHECK.
  EXECUTE 'ALTER TABLE public.devis ALTER COLUMN statut SET DEFAULT ''BROUILLON''';

  -- Drop any pre-existing statut CHECK constraint, then add the canonical one.
  BEGIN
    EXECUTE (
      SELECT string_agg(format('ALTER TABLE public.devis DROP CONSTRAINT IF EXISTS %I;', conname), ' ')
      FROM pg_constraint
      WHERE conrelid = 'public.devis'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%statut%'
    );
  EXCEPTION WHEN others THEN NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'devis_statut_check' AND conrelid = 'public.devis'::regclass
  ) THEN
    ALTER TABLE public.devis
      ADD CONSTRAINT devis_statut_check
      CHECK (statut IN ('BROUILLON','ENVOYE','ACCEPTE','REFUSE','EXPIRE','ANNULE'));
  END IF;
END $$;

COMMIT;
