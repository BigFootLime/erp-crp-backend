-- #1710: native, evidence-bound resumption of a cutover WIP cohort.
-- This patch deliberately stores checkpoints without creating pointages,
-- historical time, stock movements, material debits or production receipts.
BEGIN;

CREATE TABLE IF NOT EXISTS public.data_cutover_wip_resumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.data_cutover_batches(id) ON DELETE RESTRICT,
  row_id uuid NOT NULL REFERENCES public.data_cutover_rows(id) ON DELETE RESTRICT,
  opening_state_id uuid NOT NULL REFERENCES public.data_cutover_opening_states(id) ON DELETE RESTRICT,
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  piece_technique_version_id uuid NOT NULL REFERENCES public.piece_technique_versions(id) ON DELETE RESTRICT,
  quantity_launched numeric(14,4) NOT NULL CHECK(quantity_launched>0),
  unit text NOT NULL CHECK(length(btrim(unit)) BETWEEN 1 AND 32),
  historical_initial_quantity numeric(14,4) NULL CHECK(historical_initial_quantity IS NULL OR historical_initial_quantity>=quantity_launched),
  physical_batch_reference text NOT NULL CHECK(length(btrim(physical_batch_reference)) BETWEEN 1 AND 200),
  material_scope text NOT NULL CHECK(material_scope IN ('NONE','SINGLE_BATCH_VALIDATED')),
  material_checkpoint_id uuid NULL,
  provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object'),
  source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_cutover_wip_resumption_opening_1710_uq UNIQUE(opening_state_id),
  CONSTRAINT data_cutover_wip_resumption_of_1710_uq UNIQUE(of_id),
  CONSTRAINT data_cutover_wip_resumption_physical_batch_1710_uq UNIQUE(physical_batch_reference),
  CONSTRAINT data_cutover_wip_resumption_row_batch_1710_fk FOREIGN KEY(row_id,batch_id)
    REFERENCES public.data_cutover_rows(id,batch_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS data_cutover_wip_resumptions_batch_idx
  ON public.data_cutover_wip_resumptions(batch_id,created_at,id);

CREATE TABLE IF NOT EXISTS public.data_cutover_wip_operation_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resumption_id uuid NOT NULL REFERENCES public.data_cutover_wip_resumptions(id) ON DELETE RESTRICT,
  of_operation_id uuid NOT NULL REFERENCES public.of_operations(id) ON DELETE RESTRICT,
  phase integer NOT NULL CHECK(phase>=0),
  checkpoint_status text NOT NULL CHECK(checkpoint_status IN ('NOT_STARTED','IN_PROGRESS','COMPLETED')),
  quantity_good numeric(14,4) NOT NULL DEFAULT 0 CHECK(quantity_good>=0),
  quantity_scrap numeric(14,4) NOT NULL DEFAULT 0 CHECK(quantity_scrap>=0),
  quantity_pending_control numeric(14,4) NOT NULL DEFAULT 0 CHECK(quantity_pending_control>=0),
  unit text NOT NULL CHECK(length(btrim(unit)) BETWEEN 1 AND 32),
  evidence_reference text NOT NULL CHECK(length(btrim(evidence_reference)) BETWEEN 1 AND 500),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_cutover_wip_checkpoint_resumption_phase_1710_uq UNIQUE(resumption_id,phase),
  CONSTRAINT data_cutover_wip_checkpoint_operation_1710_uq UNIQUE(of_operation_id),
  -- An in-progress adjustment may legitimately have no completed physical
  -- piece yet. Its evidence_reference remains mandatory. A phase marked
  -- completed, however, must carry a physically confirmed result.
  CONSTRAINT data_cutover_wip_checkpoint_completed_nonempty_1710_ck CHECK(
    checkpoint_status<>'COMPLETED' OR quantity_good<>0 OR quantity_scrap<>0 OR quantity_pending_control<>0
  )
);
CREATE INDEX IF NOT EXISTS data_cutover_wip_operation_checkpoints_of_idx
  ON public.data_cutover_wip_operation_checkpoints(of_operation_id);

CREATE OR REPLACE FUNCTION public.fn_protect_data_cutover_wip_resume_1710()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cutover WIP resumptions and checkpoints are append-only' USING ERRCODE='23514';
END;
$$;
DROP TRIGGER IF EXISTS data_cutover_wip_resumption_append_only_1710 ON public.data_cutover_wip_resumptions;
CREATE TRIGGER data_cutover_wip_resumption_append_only_1710 BEFORE UPDATE OR DELETE
  ON public.data_cutover_wip_resumptions FOR EACH ROW EXECUTE FUNCTION public.fn_protect_data_cutover_wip_resume_1710();
DROP TRIGGER IF EXISTS data_cutover_wip_checkpoint_append_only_1710 ON public.data_cutover_wip_operation_checkpoints;
CREATE TRIGGER data_cutover_wip_checkpoint_append_only_1710 BEFORE UPDATE OR DELETE
  ON public.data_cutover_wip_operation_checkpoints FOR EACH ROW EXECUTE FUNCTION public.fn_protect_data_cutover_wip_resume_1710();

COMMENT ON TABLE public.data_cutover_wip_resumptions IS
  'Native OF continuation for one homogeneous cutover WIP cohort. No stock, time or receipt effect is created here.';
COMMENT ON TABLE public.data_cutover_wip_operation_checkpoints IS
  'Append-only opening quantities and operation state evidenced at cutover; distinct from real operator declarations and pointages.';

DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  GRANT SELECT,INSERT ON public.data_cutover_wip_resumptions,data_cutover_wip_operation_checkpoints TO cerp_app;
  REVOKE UPDATE,DELETE,TRUNCATE ON public.data_cutover_wip_resumptions,data_cutover_wip_operation_checkpoints FROM PUBLIC,cerp_app;
END IF; END $$;
COMMIT;
