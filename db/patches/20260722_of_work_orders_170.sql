-- Issue #170 — OF récursifs, opérations et traçabilité immuable.
-- Additive/idempotent repository patch. Apply to cerp_test only after preflight.
-- Never run on cerp_prod without an approved backup, verify report and explicit
-- human authorization (see docs/ai/atelier-gpao-v2-state.md governance).

BEGIN;

-- 0) Preflight: the #55/#141 OF ecosystem must already exist.
DO $$
BEGIN
  IF to_regclass('public.ordres_fabrication') IS NULL
     OR to_regclass('public.of_operations') IS NULL
     OR to_regclass('public.of_time_logs') IS NULL
     OR to_regclass('public.of_generation_batches') IS NULL
     OR to_regclass('public.of_structure_snapshot') IS NULL
     OR to_regclass('public.of_technical_snapshots') IS NULL
     OR to_regclass('public.lots') IS NULL
     OR to_regclass('public.affaire') IS NULL THEN
    RAISE EXCEPTION '#170 prerequisites missing: OF ecosystem tables (#55/#141) are required';
  END IF;
  IF to_regprocedure('public.fn_next_issued_code_value(text)') IS NULL THEN
    RAISE EXCEPTION '#170 prerequisite missing: fn_next_issued_code_value(text) (#141)';
  END IF;
END $$;

-- 1) Materialize of_output_lots.
-- The table is consumed by production receipts, traceability and as-built packs
-- but had no DDL in db/patches (same live-vs-repo divergence already found and
-- fixed for the fournisseurs ecosystem). CREATE IF NOT EXISTS keeps live
-- databases untouched while making the repository the schema source of truth.
CREATE TABLE IF NOT EXISTS public.of_output_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  lot_id uuid NOT NULL REFERENCES public.lots(id) ON DELETE RESTRICT,
  qty_ok numeric(12, 3) NOT NULL DEFAULT 0,
  qty_scrap numeric(12, 3) NOT NULL DEFAULT 0,
  qty_rework numeric(12, 3) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT of_output_lots_of_lot_uq UNIQUE (of_id, lot_id),
  CONSTRAINT of_output_lots_qty_ck CHECK (qty_ok >= 0 AND qty_scrap >= 0 AND qty_rework >= 0)
);
CREATE INDEX IF NOT EXISTS of_output_lots_of_idx ON public.of_output_lots(of_id);
CREATE INDEX IF NOT EXISTS of_output_lots_lot_idx ON public.of_output_lots(lot_id);
COMMENT ON TABLE public.of_output_lots IS
  'Production receipts per OF and lot. qty_ok is cumulative; receipts are bounded by ordres_fabrication.quantite_bonne.';

-- 2) Generation batches: idempotency key, request/source hashes, persisted result,
--    and the affaire context for affaire-driven or manual generations (#170 §5/§7).
ALTER TABLE public.of_generation_batches
  ADD COLUMN IF NOT EXISTS affaire_id bigint NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL,
  ADD COLUMN IF NOT EXISTS request_hash text NULL,
  ADD COLUMN IF NOT EXISTS source_hash text NULL,
  ADD COLUMN IF NOT EXISTS result jsonb NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_generation_batches_affaire_id_fkey'
      AND conrelid = 'public.of_generation_batches'::regclass
  ) THEN
    ALTER TABLE public.of_generation_batches
      ADD CONSTRAINT of_generation_batches_affaire_id_fkey
      FOREIGN KEY (affaire_id) REFERENCES public.affaire(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_generation_batches_idempotency_key_len_ck'
      AND conrelid = 'public.of_generation_batches'::regclass
  ) THEN
    ALTER TABLE public.of_generation_batches
      ADD CONSTRAINT of_generation_batches_idempotency_key_len_ck
      CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 200);
  END IF;

  -- Constrain source_type only when live data already conforms: this patch must
  -- never fail on historical rows it does not own.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_generation_batches_source_type_ck'
      AND conrelid = 'public.of_generation_batches'::regclass
  ) AND NOT EXISTS (
    SELECT 1 FROM public.of_generation_batches
    WHERE source_type NOT IN ('COMMANDE_CLIENT', 'AFFAIRE', 'MANUAL')
  ) THEN
    ALTER TABLE public.of_generation_batches
      ADD CONSTRAINT of_generation_batches_source_type_ck
      CHECK (source_type IN ('COMMANDE_CLIENT', 'AFFAIRE', 'MANUAL'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS of_generation_batches_idempotency_uq
  ON public.of_generation_batches(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS of_generation_batches_affaire_idx
  ON public.of_generation_batches(affaire_id)
  WHERE affaire_id IS NOT NULL;

COMMENT ON COLUMN public.of_generation_batches.idempotency_key IS
  'Client-supplied Idempotency-Key: an identical retry replays the persisted result instead of generating a second tree.';
COMMENT ON COLUMN public.of_generation_batches.source_hash IS
  'SHA-256 of the frozen source definition set at preview time; confirmation is refused when it no longer matches.';
COMMENT ON COLUMN public.of_generation_batches.result IS
  'Persisted generation result (of ids, codes, counts, purchase requirements). Written once at commit.';

-- 3) OF business code is immutable once issued (#141 rule, now enforced in DB).
CREATE OR REPLACE FUNCTION public.fn_prevent_of_numero_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.numero IS DISTINCT FROM NEW.numero THEN
    RAISE EXCEPTION 'OF numero is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_of_numero_mutation ON public.ordres_fabrication;
CREATE TRIGGER trg_prevent_of_numero_mutation
BEFORE UPDATE OF numero ON public.ordres_fabrication
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_of_numero_mutation();

-- 4) Structure snapshots are published historical truth: no UPDATE, no DELETE
--    (same protection as of_technical_snapshots since #141).
CREATE OR REPLACE FUNCTION public.fn_prevent_of_structure_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OF structure snapshot rows are immutable and retained for traceability'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_of_structure_snapshot_mutation ON public.of_structure_snapshot;
CREATE TRIGGER trg_prevent_of_structure_snapshot_mutation
BEFORE UPDATE OR DELETE ON public.of_structure_snapshot
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_of_structure_snapshot_mutation();

-- 5) Generation batches are audit evidence. DELETE is forbidden; UPDATE is
--    limited to the two one-shot completions the engine performs inside the
--    generation transaction (root_of_id, result). Everything else is frozen.
CREATE OR REPLACE FUNCTION public.fn_protect_of_generation_batch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'OF generation batches are immutable audit evidence'
      USING ERRCODE = '55000';
  END IF;

  IF (OLD.root_of_id IS NOT NULL AND NEW.root_of_id IS DISTINCT FROM OLD.root_of_id)
     OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result)
     OR ((to_jsonb(NEW) - ARRAY['root_of_id', 'result'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['root_of_id', 'result'])) THEN
    RAISE EXCEPTION 'OF generation batches accept only one-shot root_of_id/result completion'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_of_generation_batch ON public.of_generation_batches;
CREATE TRIGGER trg_protect_of_generation_batch
BEFORE UPDATE OR DELETE ON public.of_generation_batches
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_of_generation_batch();

-- 6) Hierarchy guard: an OF can never be its own parent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ordres_fabrication_no_self_parent_ck'
      AND conrelid = 'public.ordres_fabrication'::regclass
  ) THEN
    ALTER TABLE public.ordres_fabrication
      ADD CONSTRAINT ordres_fabrication_no_self_parent_ck
      CHECK (parent_of_id IS NULL OR parent_of_id <> id);
  END IF;
END $$;

COMMIT;
