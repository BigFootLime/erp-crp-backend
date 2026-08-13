-- SOL-20 — cycle de vie outillage, exigences techniques et liens GED contrôlés.
-- Migration additive. Aucune donnée historique n'est déclarée "propre" ou "disponible".
-- Preflight : support/20260813_sol20_tooling_technical_ged.preflight.sql
-- Validation : support/20260813_sol20_tooling_technical_ged.verify.sql
-- Rollback   : support/20260813_sol20_tooling_technical_ged.rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Le journal historique n'a pas la même largeur sur toutes les installations.
-- SOL-20 garantit les colonnes minimales utilisées par ses mouvements audités au
-- lieu de dépendre d'un fallback applicatif silencieux.
ALTER TABLE public.gestion_outils_mouvement_stock
  ADD COLUMN IF NOT EXISTS user_id integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reason text NULL,
  ADD COLUMN IF NOT EXISTS source text NULL,
  ADD COLUMN IF NOT EXISTS note text NULL,
  ADD COLUMN IF NOT EXISTS commentaire text NULL,
  ADD COLUMN IF NOT EXISTS affaire_id integer NULL;

ALTER TABLE public.gestion_outils_outil
  ADD COLUMN IF NOT EXISTS reference_fabricant text NULL,
  ADD COLUMN IF NOT EXISTS designation_outil_cnc text NULL,
  ADD COLUMN IF NOT EXISTS codification text NULL;

CREATE TABLE IF NOT EXISTS public.outillage_tool_parameter_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_outil integer NOT NULL REFERENCES public.gestion_outils_outil(id_outil) ON DELETE RESTRICT,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz NULL,
  unit_cost numeric(14,4) NULL,
  expected_life_pieces numeric(14,3) NULL,
  currency char(3) NOT NULL DEFAULT 'EUR',
  source text NOT NULL,
  source_observed_at timestamptz NOT NULL,
  reliability text NOT NULL,
  change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT outillage_tool_parameter_period_20_ck
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT outillage_tool_parameter_cost_20_ck
    CHECK (unit_cost IS NULL OR unit_cost >= 0),
  CONSTRAINT outillage_tool_parameter_life_20_ck
    CHECK (expected_life_pieces IS NULL OR expected_life_pieces > 0),
  CONSTRAINT outillage_tool_parameter_currency_20_ck
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT outillage_tool_parameter_reliability_20_ck
    CHECK (reliability IN ('DECLARED', 'MEASURED', 'VERIFIED')),
  CONSTRAINT outillage_tool_parameter_source_20_ck CHECK (length(btrim(source)) > 0),
  CONSTRAINT outillage_tool_parameter_reason_20_ck CHECK (length(btrim(change_reason)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS outillage_tool_parameter_open_20_uq
  ON public.outillage_tool_parameter_versions(id_outil)
  WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS outillage_tool_parameter_history_20_idx
  ON public.outillage_tool_parameter_versions(id_outil, effective_from DESC);

CREATE OR REPLACE FUNCTION public.fn_outillage_parameter_period_no_overlap_20()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.outillage_tool_parameter_versions p
     WHERE p.id_outil = NEW.id_outil
       AND p.id <> NEW.id
       AND tstzrange(p.effective_from, p.effective_to, '[)')
           && tstzrange(NEW.effective_from, NEW.effective_to, '[)')
  ) THEN
    RAISE EXCEPTION 'OUTILLAGE_PARAMETER_PERIOD_OVERLAP: tool=%', NEW.id_outil
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_outillage_parameter_period_no_overlap_20 ON public.outillage_tool_parameter_versions;
CREATE TRIGGER trg_outillage_parameter_period_no_overlap_20
  BEFORE INSERT OR UPDATE OF effective_from, effective_to ON public.outillage_tool_parameter_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_outillage_parameter_period_no_overlap_20();

CREATE TABLE IF NOT EXISTS public.piece_version_tool_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  piece_technique_version_id uuid NOT NULL
    REFERENCES public.piece_technique_versions(id) ON DELETE RESTRICT,
  id_outil integer NOT NULL REFERENCES public.gestion_outils_outil(id_outil) ON DELETE RESTRICT,
  required_quantity integer NOT NULL,
  usage_notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT piece_version_tool_requirement_qty_20_ck CHECK (required_quantity > 0),
  CONSTRAINT piece_version_tool_requirement_20_uq UNIQUE (piece_technique_version_id, id_outil)
);
CREATE INDEX IF NOT EXISTS piece_version_tool_requirement_tool_20_idx
  ON public.piece_version_tool_requirements(id_outil, piece_technique_version_id);

CREATE TABLE IF NOT EXISTS public.outillage_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_outil integer NOT NULL REFERENCES public.gestion_outils_outil(id_outil) ON DELETE RESTRICT,
  piece_technique_id uuid NOT NULL REFERENCES public.pieces_techniques(id) ON DELETE RESTRICT,
  piece_technique_version_id uuid NOT NULL
    REFERENCES public.piece_technique_versions(id) ON DELETE RESTRICT,
  of_id bigint NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  reserved_quantity integer NOT NULL,
  issued_quantity integer NOT NULL DEFAULT 0,
  returned_quantity integer NOT NULL DEFAULT 0,
  broken_quantity integer NOT NULL DEFAULT 0,
  worn_quantity integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'RESERVED',
  unit_cost_snapshot numeric(14,4) NULL,
  currency char(3) NULL,
  cost_source text NULL,
  cost_source_observed_at timestamptz NULL,
  cost_reliability text NOT NULL DEFAULT 'UNAVAILABLE',
  expected_life_pieces_snapshot numeric(14,3) NULL,
  reason text NOT NULL,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  closed_at timestamptz NULL,
  CONSTRAINT outillage_allocation_qty_20_ck CHECK (
    reserved_quantity > 0
    AND issued_quantity BETWEEN 0 AND reserved_quantity
    AND returned_quantity >= 0
    AND broken_quantity >= 0
    AND worn_quantity >= 0
    AND returned_quantity + broken_quantity + worn_quantity <= issued_quantity
  ),
  CONSTRAINT outillage_allocation_status_20_ck
    CHECK (status IN ('RESERVED', 'ISSUED', 'PARTIALLY_RETURNED', 'CLOSED', 'CANCELLED')),
  CONSTRAINT outillage_allocation_cost_20_ck CHECK (unit_cost_snapshot IS NULL OR unit_cost_snapshot >= 0),
  CONSTRAINT outillage_allocation_cost_quality_20_ck
    CHECK (cost_reliability IN ('UNAVAILABLE', 'DECLARED', 'MEASURED', 'VERIFIED')),
  CONSTRAINT outillage_allocation_life_20_ck
    CHECK (expected_life_pieces_snapshot IS NULL OR expected_life_pieces_snapshot > 0),
  CONSTRAINT outillage_allocation_reason_20_ck CHECK (length(btrim(reason)) > 0)
);

CREATE INDEX IF NOT EXISTS outillage_allocations_open_tool_20_idx
  ON public.outillage_allocations(id_outil, status)
  WHERE status IN ('RESERVED', 'ISSUED', 'PARTIALLY_RETURNED');
CREATE INDEX IF NOT EXISTS outillage_allocations_version_20_idx
  ON public.outillage_allocations(piece_technique_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS outillage_allocations_of_20_idx
  ON public.outillage_allocations(of_id, created_at DESC) WHERE of_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.outillage_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id uuid NOT NULL REFERENCES public.outillage_allocations(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  quantity integer NOT NULL,
  reason text NOT NULL,
  notes text NULL,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  actor_user_id integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  actor_username text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  correlation_id text NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outillage_lifecycle_event_type_20_ck
    CHECK (event_type IN ('RESERVE', 'ISSUE', 'RETURN', 'BREAK', 'WEAR', 'CANCEL')),
  CONSTRAINT outillage_lifecycle_event_qty_20_ck CHECK (quantity > 0),
  CONSTRAINT outillage_lifecycle_event_reason_20_ck CHECK (length(btrim(reason)) > 0),
  CONSTRAINT outillage_lifecycle_event_key_20_ck CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  CONSTRAINT outillage_lifecycle_event_hash_20_ck CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT outillage_lifecycle_actor_key_20_uq UNIQUE (actor_user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS outillage_lifecycle_allocation_20_idx
  ON public.outillage_lifecycle_events(allocation_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.fn_outillage_lifecycle_event_immutable_20()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OUTILLAGE_EVENT_IMMUTABLE: lifecycle events are append-only'
    USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS trg_outillage_lifecycle_event_immutable_20 ON public.outillage_lifecycle_events;
CREATE TRIGGER trg_outillage_lifecycle_event_immutable_20
  BEFORE UPDATE OR DELETE ON public.outillage_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_outillage_lifecycle_event_immutable_20();

-- Les quatre types canoniques ci-dessous sont contrôlés. Les autres types GED
-- historiques restent compatibles, mais ne gagnent aucune fausse intégrité.
CREATE OR REPLACE FUNCTION public.fn_ged_validate_canonical_entity_link_20()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entity_type = 'PIECE_TECHNIQUE'
     AND NOT EXISTS (SELECT 1 FROM public.pieces_techniques p WHERE p.id::text = NEW.entity_id) THEN
    RAISE EXCEPTION 'GED_ENTITY_NOT_FOUND: PIECE_TECHNIQUE %', NEW.entity_id USING ERRCODE = '23503';
  ELSIF NEW.entity_type = 'PIECE_TECHNIQUE_VERSION'
     AND NOT EXISTS (SELECT 1 FROM public.piece_technique_versions v WHERE v.id::text = NEW.entity_id) THEN
    RAISE EXCEPTION 'GED_ENTITY_NOT_FOUND: PIECE_TECHNIQUE_VERSION %', NEW.entity_id USING ERRCODE = '23503';
  ELSIF NEW.entity_type = 'OUTIL'
     AND NOT EXISTS (SELECT 1 FROM public.gestion_outils_outil o WHERE o.id_outil::text = NEW.entity_id) THEN
    RAISE EXCEPTION 'GED_ENTITY_NOT_FOUND: OUTIL %', NEW.entity_id USING ERRCODE = '23503';
  ELSIF NEW.entity_type = 'ORDRE_FABRICATION'
     AND NOT EXISTS (SELECT 1 FROM public.ordres_fabrication o WHERE o.id::text = NEW.entity_id) THEN
    RAISE EXCEPTION 'GED_ENTITY_NOT_FOUND: ORDRE_FABRICATION %', NEW.entity_id USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_ged_validate_canonical_entity_link_20 ON public.ged_document_links;
CREATE TRIGGER trg_ged_validate_canonical_entity_link_20
  BEFORE INSERT OR UPDATE OF entity_type, entity_id ON public.ged_document_links
  FOR EACH ROW EXECUTE FUNCTION public.fn_ged_validate_canonical_entity_link_20();

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.outillage_tool_parameter_versions TO cerp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.piece_version_tool_requirements TO cerp_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.outillage_allocations TO cerp_app;
    GRANT SELECT, INSERT ON TABLE public.outillage_lifecycle_events TO cerp_app;
  END IF;
END
$grants$;

COMMIT;
