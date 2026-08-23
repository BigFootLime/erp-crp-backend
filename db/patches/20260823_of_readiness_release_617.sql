-- #617 - Explicit, auditable OF release gate.
--
-- Migration policy: no historical OF is backfilled or inferred as ready. An
-- OF already EN_COURS/EN_PAUSE continues its already-started execution, while
-- every new entry into execution requires a RELEASED decision below.
BEGIN;

CREATE TABLE IF NOT EXISTS public.of_release_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  decision text NOT NULL DEFAULT 'RELEASED',
  override boolean NOT NULL DEFAULT false,
  blocker_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  override_reason text NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_at timestamptz NOT NULL DEFAULT now(),
  decided_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT of_release_decisions_decision_chk CHECK (decision = 'RELEASED'),
  CONSTRAINT of_release_decisions_one_per_of_uk UNIQUE (of_id),
  CONSTRAINT of_release_decisions_override_reason_chk CHECK (
    (override = false AND override_reason IS NULL) OR (override = true AND length(trim(coalesce(override_reason, ''))) >= 10)
  )
);

-- CREATE TABLE IF NOT EXISTS does not repair an early/partial installation.
-- Add every safety constraint independently so rerunning this patch converges
-- to the same protected ledger.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.of_release_decisions'::regclass
      AND conname = 'of_release_decisions_one_per_of_uk'
  ) THEN
    ALTER TABLE public.of_release_decisions
      ADD CONSTRAINT of_release_decisions_one_per_of_uk UNIQUE (of_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.of_release_decisions'::regclass
      AND conname = 'of_release_decisions_decision_chk'
  ) THEN
    ALTER TABLE public.of_release_decisions
      ADD CONSTRAINT of_release_decisions_decision_chk CHECK (decision = 'RELEASED');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.of_release_decisions'::regclass
      AND conname = 'of_release_decisions_override_reason_chk'
  ) THEN
    ALTER TABLE public.of_release_decisions
      ADD CONSTRAINT of_release_decisions_override_reason_chk CHECK (
        (override = false AND override_reason IS NULL)
        OR (override = true AND length(trim(coalesce(override_reason, ''))) >= 10)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS of_release_decisions_of_decided_idx
  ON public.of_release_decisions (of_id, decided_at DESC);

-- A release is a signed manufacturing decision, never mutable application
-- state. Corrections are made through later audited business actions, not by
-- rewriting or deleting the evidence that allowed work to start.
CREATE OR REPLACE FUNCTION public.fn_of_release_decisions_append_only_617()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'OF release decisions are immutable audit evidence'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_of_release_decisions_append_only_617
  ON public.of_release_decisions;
CREATE TRIGGER trg_of_release_decisions_append_only_617
  BEFORE UPDATE OR DELETE ON public.of_release_decisions
  FOR EACH ROW EXECUTE FUNCTION public.fn_of_release_decisions_append_only_617();

-- Database-level backstop: application routes are not the only possible
-- writer. Historical OFs are untouched; only a new pre-launch -> execution
-- transition must be backed by the immutable release decision in this same
-- transaction.
CREATE OR REPLACE FUNCTION public.fn_guard_of_execution_release_617()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.statut IN ('BROUILLON', 'PLANIFIE')
     AND NEW.statut = 'EN_COURS'
     AND NOT EXISTS (
       SELECT 1 FROM public.of_release_decisions decision
       WHERE decision.of_id = NEW.id AND decision.decision = 'RELEASED'
     ) THEN
    RAISE EXCEPTION 'OF execution requires an immutable release decision'
      USING ERRCODE = '55000', CONSTRAINT = 'of_execution_release_required_617';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_of_execution_release_617 ON public.ordres_fabrication;
CREATE TRIGGER trg_guard_of_execution_release_617
BEFORE UPDATE OF statut ON public.ordres_fabrication
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_of_execution_release_617();

REVOKE ALL ON TABLE public.of_release_decisions FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT ON TABLE public.of_release_decisions TO cerp_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.of_release_decisions FROM cerp_app;
  END IF;
END $$;

COMMIT;
