-- Production core: Machines / Postes + Ordres de Fabrication (OF)
-- Date: 2026-02-12

BEGIN;

-- -------------------------
-- Enum types (safe create)
-- -------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'machine_type') THEN
    CREATE TYPE public.machine_type AS ENUM ('MILLING', 'TURNING', 'EDM', 'GRINDING', 'OTHER');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'machine_status') THEN
    CREATE TYPE public.machine_status AS ENUM ('ACTIVE', 'IN_MAINTENANCE', 'OUT_OF_SERVICE');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'of_status') THEN
    CREATE TYPE public.of_status AS ENUM ('BROUILLON', 'PLANIFIE', 'EN_COURS', 'EN_PAUSE', 'TERMINE', 'CLOTURE', 'ANNULE');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'of_priority') THEN
    CREATE TYPE public.of_priority AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'of_operation_status') THEN
    CREATE TYPE public.of_operation_status AS ENUM ('TODO', 'READY', 'RUNNING', 'DONE', 'BLOCKED');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'of_time_log_type') THEN
    CREATE TYPE public.of_time_log_type AS ENUM ('SETUP', 'PRODUCTION', 'PROGRAMMING', 'CONTROL', 'MAINTENANCE');
  END IF;
END $$;

-- -------------------------
-- Machines / Postes
-- -------------------------

CREATE TABLE IF NOT EXISTS public.machines
(
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  type public.machine_type NOT NULL DEFAULT 'OTHER',
  brand text,
  model text,
  serial_number text,
  image_path text,
  hourly_rate numeric(12, 2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'EUR',
  status public.machine_status NOT NULL DEFAULT 'ACTIVE',
  is_available boolean NOT NULL DEFAULT true,
  location text,
  workshop_zone text,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by integer,
  updated_by integer,
  archived_at timestamp with time zone,
  archived_by integer,
  CONSTRAINT machines_pkey PRIMARY KEY (id),
  CONSTRAINT machines_code_key UNIQUE (code),
  CONSTRAINT machines_hourly_rate_ck CHECK (hourly_rate >= 0)
);

ALTER TABLE IF EXISTS public.machines
  ADD CONSTRAINT machines_created_by_fkey FOREIGN KEY (created_by)
  REFERENCES public.users (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.machines
  ADD CONSTRAINT machines_updated_by_fkey FOREIGN KEY (updated_by)
  REFERENCES public.users (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.machines
  ADD CONSTRAINT machines_archived_by_fkey FOREIGN KEY (archived_by)
  REFERENCES public.users (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_machines_type
  ON public.machines(type);

CREATE INDEX IF NOT EXISTS idx_machines_status
  ON public.machines(status);

CREATE INDEX IF NOT EXISTS idx_machines_is_available
  ON public.machines(is_available);

CREATE INDEX IF NOT EXISTS idx_machines_archived_at
  ON public.machines(archived_at);

CREATE TABLE IF NOT EXISTS public.postes
(
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  label text NOT NULL,
  machine_id uuid,
  hourly_rate_override numeric(12, 2),
  currency text NOT NULL DEFAULT 'EUR',
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by integer,
  updated_by integer,
  archived_at timestamp with time zone,
  archived_by integer,
  CONSTRAINT postes_pkey PRIMARY KEY (id),
  CONSTRAINT postes_code_key UNIQUE (code),
  CONSTRAINT postes_hourly_rate_override_ck CHECK (hourly_rate_override IS NULL OR hourly_rate_override >= 0)
);

ALTER TABLE IF EXISTS public.postes
  ADD CONSTRAINT postes_machine_id_fkey FOREIGN KEY (machine_id)
  REFERENCES public.machines (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.postes
  ADD CONSTRAINT postes_created_by_fkey FOREIGN KEY (created_by)
  REFERENCES public.users (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.postes
  ADD CONSTRAINT postes_updated_by_fkey FOREIGN KEY (updated_by)
  REFERENCES public.users (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.postes
  ADD CONSTRAINT postes_archived_by_fkey FOREIGN KEY (archived_by)
  REFERENCES public.users (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_postes_machine_id
  ON public.postes(machine_id);

CREATE INDEX IF NOT EXISTS idx_postes_is_active
  ON public.postes(is_active);

CREATE INDEX IF NOT EXISTS idx_postes_archived_at
  ON public.postes(archived_at);

-- -------------------------
-- Ordres de Fabrication (OF)
-- -------------------------

CREATE TABLE IF NOT EXISTS public.ordres_fabrication
(
  id bigserial NOT NULL,
  numero character varying(30) NOT NULL,
  affaire_id bigint,
  commande_id bigint,
  client_id character varying(3),
  piece_technique_id uuid NOT NULL,
  quantite_lancee numeric(12, 3) NOT NULL DEFAULT 1,
  quantite_bonne numeric(12, 3) NOT NULL DEFAULT 0,
  quantite_rebut numeric(12, 3) NOT NULL DEFAULT 0,
  statut public.of_status NOT NULL DEFAULT 'BROUILLON',
  priority public.of_priority NOT NULL DEFAULT 'NORMAL',
  date_lancement_prevue date,
  date_fin_prevue date,
  date_lancement_reelle date,
  date_fin_reelle date,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by integer,
  updated_by integer,
  CONSTRAINT ordres_fabrication_pkey PRIMARY KEY (id),
  CONSTRAINT ordres_fabrication_numero_key UNIQUE (numero),
  CONSTRAINT ordres_fabrication_quantites_ck CHECK (
    quantite_lancee > 0
    AND quantite_bonne >= 0
    AND quantite_rebut >= 0
  )
);

ALTER TABLE IF EXISTS public.ordres_fabrication
  ADD CONSTRAINT ordres_fabrication_affaire_id_fkey FOREIGN KEY (affaire_id)
  REFERENCES public.affaire (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.ordres_fabrication
  ADD CONSTRAINT ordres_fabrication_commande_id_fkey FOREIGN KEY (commande_id)
  REFERENCES public.commande_client (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.ordres_fabrication
  ADD CONSTRAINT ordres_fabrication_client_id_fkey FOREIGN KEY (client_id)
  REFERENCES public.clients (client_id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.ordres_fabrication
  ADD CONSTRAINT ordres_fabrication_piece_technique_id_fkey FOREIGN KEY (piece_technique_id)
  REFERENCES public.pieces_techniques (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE RESTRICT;

ALTER TABLE IF EXISTS public.ordres_fabrication
  ADD CONSTRAINT ordres_fabrication_created_by_fkey FOREIGN KEY (created_by)
  REFERENCES public.users (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.ordres_fabrication
  ADD CONSTRAINT ordres_fabrication_updated_by_fkey FOREIGN KEY (updated_by)
  REFERENCES public.users (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_of_statut
  ON public.ordres_fabrication(statut);

CREATE INDEX IF NOT EXISTS idx_of_priority
  ON public.ordres_fabrication(priority);

CREATE INDEX IF NOT EXISTS idx_of_affaire_id
  ON public.ordres_fabrication(affaire_id);

CREATE INDEX IF NOT EXISTS idx_of_commande_id
  ON public.ordres_fabrication(commande_id);

CREATE INDEX IF NOT EXISTS idx_of_client_id
  ON public.ordres_fabrication(client_id);

CREATE INDEX IF NOT EXISTS idx_of_piece_technique_id
  ON public.ordres_fabrication(piece_technique_id);

CREATE INDEX IF NOT EXISTS idx_of_date_lancement_prevue
  ON public.ordres_fabrication(date_lancement_prevue);

CREATE INDEX IF NOT EXISTS idx_of_date_fin_prevue
  ON public.ordres_fabrication(date_fin_prevue);

CREATE TABLE IF NOT EXISTS public.of_operations
(
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL,
  phase integer NOT NULL,
  designation text NOT NULL,
  cf_id uuid,
  poste_id uuid,
  machine_id uuid,
  hourly_rate_applied numeric(12, 2) NOT NULL DEFAULT 0,
  tp numeric(12, 3) NOT NULL DEFAULT 0,
  tf_unit numeric(12, 3) NOT NULL DEFAULT 0,
  qte numeric(12, 3) NOT NULL DEFAULT 1,
  coef numeric(10, 3) NOT NULL DEFAULT 1,
  temps_total_planned numeric(12, 3) NOT NULL DEFAULT 0,
  temps_total_real numeric(12, 3) NOT NULL DEFAULT 0,
  status public.of_operation_status NOT NULL DEFAULT 'TODO',
  started_at timestamp with time zone,
  ended_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT of_operations_pkey PRIMARY KEY (id),
  CONSTRAINT of_operations_of_id_phase_key UNIQUE (of_id, phase),
  CONSTRAINT of_operations_hourly_rate_ck CHECK (hourly_rate_applied >= 0)
);

ALTER TABLE IF EXISTS public.of_operations
  ADD CONSTRAINT of_operations_of_id_fkey FOREIGN KEY (of_id)
  REFERENCES public.ordres_fabrication (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.of_operations
  ADD CONSTRAINT of_operations_cf_id_fkey FOREIGN KEY (cf_id)
  REFERENCES public.centres_frais (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.of_operations
  ADD CONSTRAINT of_operations_poste_id_fkey FOREIGN KEY (poste_id)
  REFERENCES public.postes (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.of_operations
  ADD CONSTRAINT of_operations_machine_id_fkey FOREIGN KEY (machine_id)
  REFERENCES public.machines (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_of_operations_of_id
  ON public.of_operations(of_id);

CREATE INDEX IF NOT EXISTS idx_of_operations_status
  ON public.of_operations(status);

CREATE INDEX IF NOT EXISTS idx_of_operations_machine_id
  ON public.of_operations(machine_id);

CREATE TABLE IF NOT EXISTS public.of_time_logs
(
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  of_operation_id uuid NOT NULL,
  user_id integer NOT NULL,
  machine_id uuid,
  started_at timestamp with time zone NOT NULL,
  ended_at timestamp with time zone,
  duration_minutes integer,
  type public.of_time_log_type NOT NULL DEFAULT 'PRODUCTION',
  comment text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT of_time_logs_pkey PRIMARY KEY (id),
  CONSTRAINT of_time_logs_duration_ck CHECK (duration_minutes IS NULL OR duration_minutes >= 0),
  CONSTRAINT of_time_logs_ended_after_started_ck CHECK (ended_at IS NULL OR ended_at >= started_at)
);

ALTER TABLE IF EXISTS public.of_time_logs
  ADD CONSTRAINT of_time_logs_of_operation_id_fkey FOREIGN KEY (of_operation_id)
  REFERENCES public.of_operations (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.of_time_logs
  ADD CONSTRAINT of_time_logs_user_id_fkey FOREIGN KEY (user_id)
  REFERENCES public.users (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE RESTRICT;

ALTER TABLE IF EXISTS public.of_time_logs
  ADD CONSTRAINT of_time_logs_machine_id_fkey FOREIGN KEY (machine_id)
  REFERENCES public.machines (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_of_time_logs_of_operation_id
  ON public.of_time_logs(of_operation_id);

CREATE INDEX IF NOT EXISTS idx_of_time_logs_user_id
  ON public.of_time_logs(user_id);

CREATE INDEX IF NOT EXISTS idx_of_time_logs_started_at
  ON public.of_time_logs(started_at);

CREATE UNIQUE INDEX IF NOT EXISTS ux_of_time_logs_open_per_user_op
  ON public.of_time_logs(of_operation_id, user_id)
  WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS public.of_quality_logs
(
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL,
  of_operation_id uuid,
  user_id integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  kind text NOT NULL,
  comment text,
  data jsonb,
  CONSTRAINT of_quality_logs_pkey PRIMARY KEY (id)
);

ALTER TABLE IF EXISTS public.of_quality_logs
  ADD CONSTRAINT of_quality_logs_of_id_fkey FOREIGN KEY (of_id)
  REFERENCES public.ordres_fabrication (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.of_quality_logs
  ADD CONSTRAINT of_quality_logs_of_operation_id_fkey FOREIGN KEY (of_operation_id)
  REFERENCES public.of_operations (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.of_quality_logs
  ADD CONSTRAINT of_quality_logs_user_id_fkey FOREIGN KEY (user_id)
  REFERENCES public.users (id) MATCH SIMPLE
  ON UPDATE NO ACTION
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_of_quality_logs_of_id
  ON public.of_quality_logs(of_id);

CREATE INDEX IF NOT EXISTS idx_of_quality_logs_created_at
  ON public.of_quality_logs(created_at);

COMMIT;
