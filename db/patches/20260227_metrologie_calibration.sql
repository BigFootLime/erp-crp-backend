-- PHASE 10 - Metrologie / Etalonnage (Calibration)
-- Idempotent patch: safe to run multiple times.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Generic ERP settings (key/value)                                         */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.erp_settings (
  key TEXT PRIMARY KEY,
  value_text TEXT NULL,
  value_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'erp_settings_created_by_fkey'
      AND conrelid = 'public.erp_settings'::regclass
  ) THEN
    ALTER TABLE public.erp_settings
      ADD CONSTRAINT erp_settings_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'erp_settings_updated_by_fkey'
      AND conrelid = 'public.erp_settings'::regclass
  ) THEN
    ALTER TABLE public.erp_settings
      ADD CONSTRAINT erp_settings_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Optional rule to block quality/shipping when overdue critical equipment exists.
INSERT INTO public.erp_settings (key, value_json)
VALUES ('metrologie.block_on_overdue_critical', '{"enabled": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;

/* -------------------------------------------------------------------------- */
/* 1) Equipements                                                              */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.metrologie_equipements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NULL,
  designation TEXT NOT NULL,
  categorie TEXT NULL,
  marque TEXT NULL,
  modele TEXT NULL,
  numero_serie TEXT NULL,
  localisation TEXT NULL,
  criticite TEXT NOT NULL DEFAULT 'NORMAL',
  statut TEXT NOT NULL DEFAULT 'ACTIF',
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL,
  deleted_at TIMESTAMPTZ NULL,
  deleted_by INTEGER NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS metrologie_equipements_code_uniq
  ON public.metrologie_equipements (code)
  WHERE code IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS metrologie_equipements_designation_idx
  ON public.metrologie_equipements (designation);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_equipements_criticite_check'
      AND conrelid = 'public.metrologie_equipements'::regclass
  ) THEN
    ALTER TABLE public.metrologie_equipements
      ADD CONSTRAINT metrologie_equipements_criticite_check
      CHECK (criticite IN ('NORMAL','CRITIQUE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_equipements_statut_check'
      AND conrelid = 'public.metrologie_equipements'::regclass
  ) THEN
    ALTER TABLE public.metrologie_equipements
      ADD CONSTRAINT metrologie_equipements_statut_check
      CHECK (statut IN ('ACTIF','INACTIF','REBUT'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_equipements_created_by_fkey'
      AND conrelid = 'public.metrologie_equipements'::regclass
  ) THEN
    ALTER TABLE public.metrologie_equipements
      ADD CONSTRAINT metrologie_equipements_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_equipements_updated_by_fkey'
      AND conrelid = 'public.metrologie_equipements'::regclass
  ) THEN
    ALTER TABLE public.metrologie_equipements
      ADD CONSTRAINT metrologie_equipements_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_equipements_deleted_by_fkey'
      AND conrelid = 'public.metrologie_equipements'::regclass
  ) THEN
    ALTER TABLE public.metrologie_equipements
      ADD CONSTRAINT metrologie_equipements_deleted_by_fkey
      FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2) Planification d'etalonnage                                               */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.metrologie_plan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  equipement_id UUID NOT NULL,
  periodicite_mois INTEGER NOT NULL,
  last_done_date DATE NULL,
  next_due_date DATE NULL,
  statut TEXT NOT NULL DEFAULT 'EN_COURS',
  commentaire TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL,
  deleted_at TIMESTAMPTZ NULL,
  deleted_by INTEGER NULL
);

CREATE INDEX IF NOT EXISTS metrologie_plan_equipement_idx
  ON public.metrologie_plan (equipement_id);

CREATE UNIQUE INDEX IF NOT EXISTS metrologie_plan_equipement_uniq
  ON public.metrologie_plan (equipement_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS metrologie_plan_next_due_date_idx
  ON public.metrologie_plan (next_due_date)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS metrologie_plan_statut_next_due_date_idx
  ON public.metrologie_plan (statut, next_due_date)
  WHERE deleted_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_plan_periodicite_check'
      AND conrelid = 'public.metrologie_plan'::regclass
  ) THEN
    ALTER TABLE public.metrologie_plan
      ADD CONSTRAINT metrologie_plan_periodicite_check
      CHECK (periodicite_mois > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_plan_statut_check'
      AND conrelid = 'public.metrologie_plan'::regclass
  ) THEN
    ALTER TABLE public.metrologie_plan
      ADD CONSTRAINT metrologie_plan_statut_check
      CHECK (statut IN ('EN_COURS','SUSPENDU'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_plan_equipement_fkey'
      AND conrelid = 'public.metrologie_plan'::regclass
  ) THEN
    ALTER TABLE public.metrologie_plan
      ADD CONSTRAINT metrologie_plan_equipement_fkey
      FOREIGN KEY (equipement_id) REFERENCES public.metrologie_equipements(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_plan_created_by_fkey'
      AND conrelid = 'public.metrologie_plan'::regclass
  ) THEN
    ALTER TABLE public.metrologie_plan
      ADD CONSTRAINT metrologie_plan_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_plan_updated_by_fkey'
      AND conrelid = 'public.metrologie_plan'::regclass
  ) THEN
    ALTER TABLE public.metrologie_plan
      ADD CONSTRAINT metrologie_plan_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_plan_deleted_by_fkey'
      AND conrelid = 'public.metrologie_plan'::regclass
  ) THEN
    ALTER TABLE public.metrologie_plan
      ADD CONSTRAINT metrologie_plan_deleted_by_fkey
      FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Update/extend allowed plan statuses (idempotent).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_plan_statut_check'
      AND conrelid = 'public.metrologie_plan'::regclass
  ) THEN
    ALTER TABLE public.metrologie_plan
      DROP CONSTRAINT metrologie_plan_statut_check;
  END IF;

  ALTER TABLE public.metrologie_plan
    ADD CONSTRAINT metrologie_plan_statut_check
    CHECK (statut IN ('EN_COURS','SUSPENDU','EN_RETARD','HORS_TOLERANCE'));
END $$;

/* -------------------------------------------------------------------------- */
/* 3) Certificats d'etalonnage                                                 */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.metrologie_certificats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  equipement_id UUID NOT NULL,
  date_etalonnage DATE NOT NULL,
  date_echeance DATE NULL,
  resultat TEXT NOT NULL,
  organisme TEXT NULL,
  commentaire TEXT NULL,
  file_original_name TEXT NULL,
  storage_path TEXT NULL,
  mime_type TEXT NULL,
  size_bytes BIGINT NULL,
  sha256 TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL,
  deleted_at TIMESTAMPTZ NULL,
  deleted_by INTEGER NULL
);

CREATE INDEX IF NOT EXISTS metrologie_certificats_equipement_idx
  ON public.metrologie_certificats (equipement_id);

CREATE INDEX IF NOT EXISTS metrologie_certificats_date_etalonnage_idx
  ON public.metrologie_certificats (date_etalonnage);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_certificats_resultat_check'
      AND conrelid = 'public.metrologie_certificats'::regclass
  ) THEN
    ALTER TABLE public.metrologie_certificats
      ADD CONSTRAINT metrologie_certificats_resultat_check
      CHECK (resultat IN ('CONFORME','NON_CONFORME','AJUSTAGE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_certificats_equipement_fkey'
      AND conrelid = 'public.metrologie_certificats'::regclass
  ) THEN
    ALTER TABLE public.metrologie_certificats
      ADD CONSTRAINT metrologie_certificats_equipement_fkey
      FOREIGN KEY (equipement_id) REFERENCES public.metrologie_equipements(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_certificats_created_by_fkey'
      AND conrelid = 'public.metrologie_certificats'::regclass
  ) THEN
    ALTER TABLE public.metrologie_certificats
      ADD CONSTRAINT metrologie_certificats_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_certificats_updated_by_fkey'
      AND conrelid = 'public.metrologie_certificats'::regclass
  ) THEN
    ALTER TABLE public.metrologie_certificats
      ADD CONSTRAINT metrologie_certificats_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_certificats_deleted_by_fkey'
      AND conrelid = 'public.metrologie_certificats'::regclass
  ) THEN
    ALTER TABLE public.metrologie_certificats
      ADD CONSTRAINT metrologie_certificats_deleted_by_fkey
      FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 4) Event log                                                                */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.metrologie_event_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  equipement_id UUID NULL,
  event_type TEXT NOT NULL,
  old_values JSONB NULL,
  new_values JSONB NULL,
  user_id INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS metrologie_event_log_equipement_idx
  ON public.metrologie_event_log (equipement_id);

CREATE INDEX IF NOT EXISTS metrologie_event_log_created_at_idx
  ON public.metrologie_event_log (created_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_event_log_equipement_fkey'
      AND conrelid = 'public.metrologie_event_log'::regclass
  ) THEN
    ALTER TABLE public.metrologie_event_log
      ADD CONSTRAINT metrologie_event_log_equipement_fkey
      FOREIGN KEY (equipement_id) REFERENCES public.metrologie_equipements(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_event_log_user_fkey'
      AND conrelid = 'public.metrologie_event_log'::regclass
  ) THEN
    ALTER TABLE public.metrologie_event_log
      ADD CONSTRAINT metrologie_event_log_user_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMIT;
