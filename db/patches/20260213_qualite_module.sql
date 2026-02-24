-- 20260213_qualite_module.sql
-- Qualite module (ISO 9001 mindset):
-- - Controles qualite + points de controle (mesures)
-- - Non-conformites
-- - Actions qualite (CAPA)
-- - Documents qualite (PV, photos, certificats...)
-- - Event log (append-only) for full traceability
--
-- Notes:
-- - Uses gen_random_uuid() => requires pgcrypto.
-- - updated_at triggers use public.tg_set_updated_at() if present (same pattern as other patches).

/* -------------------------------------------------------------------------- */
/* 0) Optional extensions                                                     */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping extension pgcrypto (insufficient_privilege)';
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Enum types (safe create)                                                */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quality_control_type') THEN
    CREATE TYPE public.quality_control_type AS ENUM ('IN_PROCESS', 'FINAL', 'RECEPTION', 'PERIODIC');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quality_control_status') THEN
    CREATE TYPE public.quality_control_status AS ENUM ('PLANNED', 'IN_PROGRESS', 'VALIDATED', 'REJECTED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quality_control_result') THEN
    CREATE TYPE public.quality_control_result AS ENUM ('OK', 'NOK', 'PARTIAL');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quality_point_result') THEN
    CREATE TYPE public.quality_point_result AS ENUM ('OK', 'NOK');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quality_nc_severity') THEN
    CREATE TYPE public.quality_nc_severity AS ENUM ('MINOR', 'MAJOR', 'CRITICAL');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quality_nc_status') THEN
    CREATE TYPE public.quality_nc_status AS ENUM ('OPEN', 'ANALYSIS', 'ACTION_PLAN', 'CLOSED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quality_action_type') THEN
    CREATE TYPE public.quality_action_type AS ENUM ('CORRECTIVE', 'PREVENTIVE');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quality_action_status') THEN
    CREATE TYPE public.quality_action_status AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'VERIFIED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quality_entity_type') THEN
    CREATE TYPE public.quality_entity_type AS ENUM ('CONTROL', 'NON_CONFORMITY', 'ACTION');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quality_document_type') THEN
    CREATE TYPE public.quality_document_type AS ENUM ('PV', 'PHOTO', 'CERTIFICATE', 'REPORT', 'OTHER');
  END IF;
END$$;

/* -------------------------------------------------------------------------- */
/* 2) Non-conformity reference generator                                      */
/* -------------------------------------------------------------------------- */

CREATE SEQUENCE IF NOT EXISTS public.quality_nc_reference_seq;

CREATE OR REPLACE FUNCTION public.quality_generate_nc_reference()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v bigint;
  y text;
BEGIN
  v := nextval('public.quality_nc_reference_seq');
  y := to_char(now(), 'YYYY');
  RETURN 'NC-' || y || '-' || lpad(v::text, 5, '0');
END;
$$;

/* -------------------------------------------------------------------------- */
/* 3) Core tables                                                             */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.quality_control (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  affaire_id bigint NULL
    REFERENCES public.affaire(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  of_id bigint NULL
    REFERENCES public.ordres_fabrication(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  piece_technique_id uuid NULL
    REFERENCES public.pieces_techniques(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  operation_id uuid NULL
    REFERENCES public.of_operations(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  machine_id uuid NULL
    REFERENCES public.machines(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  poste_id uuid NULL
    REFERENCES public.postes(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  control_type public.quality_control_type NOT NULL,
  status public.quality_control_status NOT NULL DEFAULT 'PLANNED',
  result public.quality_control_result NULL,

  control_date timestamptz NOT NULL DEFAULT now(),
  controlled_by integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  validated_by integer NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  validation_date timestamptz NULL,

  comments text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_by integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT quality_control_context_chk CHECK (
    affaire_id IS NOT NULL OR of_id IS NOT NULL OR piece_technique_id IS NOT NULL
  ),
  CONSTRAINT quality_control_operation_requires_of_chk CHECK (
    operation_id IS NULL OR of_id IS NOT NULL
  ),
  CONSTRAINT quality_control_validation_pair_chk CHECK ((validation_date IS NULL) = (validated_by IS NULL)),
  CONSTRAINT quality_control_validated_status_chk CHECK (
    (validation_date IS NULL AND validated_by IS NULL AND status IN ('PLANNED','IN_PROGRESS'))
    OR (validation_date IS NOT NULL AND validated_by IS NOT NULL AND status IN ('VALIDATED','REJECTED'))
  )
);

CREATE INDEX IF NOT EXISTS quality_control_affaire_id_idx ON public.quality_control (affaire_id);
CREATE INDEX IF NOT EXISTS quality_control_of_id_idx ON public.quality_control (of_id);
CREATE INDEX IF NOT EXISTS quality_control_piece_technique_id_idx ON public.quality_control (piece_technique_id);
CREATE INDEX IF NOT EXISTS quality_control_operation_id_idx ON public.quality_control (operation_id);
CREATE INDEX IF NOT EXISTS quality_control_machine_id_idx ON public.quality_control (machine_id);
CREATE INDEX IF NOT EXISTS quality_control_control_date_idx ON public.quality_control (control_date);
CREATE INDEX IF NOT EXISTS quality_control_status_idx ON public.quality_control (status);
CREATE INDEX IF NOT EXISTS quality_control_result_idx ON public.quality_control (result);

CREATE TABLE IF NOT EXISTS public.quality_control_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quality_control_id uuid NOT NULL
    REFERENCES public.quality_control(id) ON UPDATE RESTRICT ON DELETE CASCADE,

  characteristic text NOT NULL,
  nominal_value numeric NULL,
  tolerance_min numeric NULL,
  tolerance_max numeric NULL,
  measured_value numeric NULL,
  unit text NULL,
  result public.quality_point_result NULL,
  comment text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quality_control_points_tol_range_chk CHECK (
    tolerance_min IS NULL OR tolerance_max IS NULL OR tolerance_min <= tolerance_max
  )
);

CREATE INDEX IF NOT EXISTS quality_control_points_control_id_idx ON public.quality_control_points (quality_control_id);
CREATE INDEX IF NOT EXISTS quality_control_points_result_idx ON public.quality_control_points (result);

CREATE TABLE IF NOT EXISTS public.non_conformity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE DEFAULT public.quality_generate_nc_reference(),

  affaire_id bigint NULL
    REFERENCES public.affaire(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  of_id bigint NULL
    REFERENCES public.ordres_fabrication(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  piece_technique_id uuid NULL
    REFERENCES public.pieces_techniques(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  control_id uuid NULL
    REFERENCES public.quality_control(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  client_id text NULL
    REFERENCES public.clients(client_id) ON UPDATE RESTRICT ON DELETE SET NULL,

  description text NOT NULL,
  severity public.quality_nc_severity NOT NULL DEFAULT 'MINOR',
  status public.quality_nc_status NOT NULL DEFAULT 'OPEN',
  detected_by integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  detection_date timestamptz NOT NULL DEFAULT now(),

  root_cause text NULL,
  impact text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_by integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS non_conformity_affaire_id_idx ON public.non_conformity (affaire_id);
CREATE INDEX IF NOT EXISTS non_conformity_of_id_idx ON public.non_conformity (of_id);
CREATE INDEX IF NOT EXISTS non_conformity_piece_technique_id_idx ON public.non_conformity (piece_technique_id);
CREATE INDEX IF NOT EXISTS non_conformity_control_id_idx ON public.non_conformity (control_id);
CREATE INDEX IF NOT EXISTS non_conformity_client_id_idx ON public.non_conformity (client_id);
CREATE INDEX IF NOT EXISTS non_conformity_detection_date_idx ON public.non_conformity (detection_date);
CREATE INDEX IF NOT EXISTS non_conformity_status_idx ON public.non_conformity (status);
CREATE INDEX IF NOT EXISTS non_conformity_severity_idx ON public.non_conformity (severity);

CREATE TABLE IF NOT EXISTS public.quality_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  non_conformity_id uuid NOT NULL
    REFERENCES public.non_conformity(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  action_type public.quality_action_type NOT NULL,
  description text NOT NULL,
  responsible_user_id integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  due_date date NULL,
  status public.quality_action_status NOT NULL DEFAULT 'OPEN',

  verification_user_id integer NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  verification_date timestamptz NULL,
  effectiveness_comment text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_by integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT quality_action_verification_pair_chk CHECK ((verification_date IS NULL) = (verification_user_id IS NULL)),
  CONSTRAINT quality_action_verified_status_chk CHECK (
    status <> 'VERIFIED'
    OR (verification_user_id IS NOT NULL AND verification_date IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS quality_action_non_conformity_id_idx ON public.quality_action (non_conformity_id);
CREATE INDEX IF NOT EXISTS quality_action_responsible_user_id_idx ON public.quality_action (responsible_user_id);
CREATE INDEX IF NOT EXISTS quality_action_due_date_idx ON public.quality_action (due_date);
CREATE INDEX IF NOT EXISTS quality_action_status_idx ON public.quality_action (status);
CREATE INDEX IF NOT EXISTS quality_action_type_idx ON public.quality_action (action_type);

/* -------------------------------------------------------------------------- */
/* 4) Documents qualite (file metadata + entity link)                          */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.quality_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  entity_type public.quality_entity_type NOT NULL,
  entity_id uuid NOT NULL,

  document_type public.quality_document_type NOT NULL,
  version integer NOT NULL DEFAULT 1,

  original_name text NOT NULL,
  stored_name text NOT NULL,
  storage_path text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NULL,
  label text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by integer NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  removed_at timestamptz NULL,
  removed_by integer NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  CONSTRAINT quality_documents_version_positive_chk CHECK (version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS quality_documents_storage_path_uniq ON public.quality_documents (storage_path);
CREATE INDEX IF NOT EXISTS quality_documents_entity_idx ON public.quality_documents (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS quality_documents_entity_active_idx ON public.quality_documents (entity_type, entity_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS quality_documents_created_at_idx ON public.quality_documents (created_at);

/* -------------------------------------------------------------------------- */
/* 5) ISO traceability: append-only event log                                  */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.quality_event_log (
  id bigserial PRIMARY KEY,
  entity_type public.quality_entity_type NOT NULL,
  entity_id uuid NOT NULL,
  event_type text NOT NULL,
  old_values jsonb NULL,
  new_values jsonb NULL,
  user_id integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quality_event_log_entity_idx
  ON public.quality_event_log (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS quality_event_log_user_created_at_idx
  ON public.quality_event_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS quality_event_log_event_type_idx
  ON public.quality_event_log (event_type);

/* -------------------------------------------------------------------------- */
/* 6) updated_at triggers (optional)                                           */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regprocedure('public.tg_set_updated_at()') IS NULL THEN
    RAISE NOTICE 'tg_set_updated_at() not found; skipping updated_at triggers.';
    RETURN;
  END IF;

  EXECUTE 'DROP TRIGGER IF EXISTS quality_control_set_updated_at ON public.quality_control';
  EXECUTE 'CREATE TRIGGER quality_control_set_updated_at BEFORE UPDATE ON public.quality_control FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS quality_control_points_set_updated_at ON public.quality_control_points';
  EXECUTE 'CREATE TRIGGER quality_control_points_set_updated_at BEFORE UPDATE ON public.quality_control_points FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS non_conformity_set_updated_at ON public.non_conformity';
  EXECUTE 'CREATE TRIGGER non_conformity_set_updated_at BEFORE UPDATE ON public.non_conformity FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS quality_action_set_updated_at ON public.quality_action';
  EXECUTE 'CREATE TRIGGER quality_action_set_updated_at BEFORE UPDATE ON public.quality_action FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS quality_documents_set_updated_at ON public.quality_documents';
  EXECUTE 'CREATE TRIGGER quality_documents_set_updated_at BEFORE UPDATE ON public.quality_documents FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
END $$;

/* -------------------------------------------------------------------------- */
/* 7) Comments (optional, helpful)                                             */
/* -------------------------------------------------------------------------- */

COMMENT ON TABLE public.quality_control IS 'Quality control instances (in-process/final/reception/periodic) with ISO traceability.';
COMMENT ON TABLE public.quality_control_points IS 'Measurements/characteristics recorded within a quality control.';
COMMENT ON TABLE public.non_conformity IS 'Non-conformities (NCR) linked to controls/OF/pieces/clients.';
COMMENT ON TABLE public.quality_action IS 'Corrective/Preventive actions (CAPA) linked to a non-conformity.';
COMMENT ON TABLE public.quality_documents IS 'Quality documents (PV, photos, certificates, reports) attached to controls/non-conformities/actions.';
COMMENT ON TABLE public.quality_event_log IS 'Append-only event log for the Qualite module: old/new jsonb + author + timestamp.';
