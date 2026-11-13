-- #1710: immutable material opening facts for a resumed WIP cohort.
-- This records what was already consumed before CERP.  It deliberately does
-- not create stock, a reservation, a stock movement, a material debit, a
-- production declaration, a receipt or a pointage.
BEGIN;

CREATE TABLE IF NOT EXISTS public.data_cutover_wip_material_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.data_cutover_batches(id) ON DELETE RESTRICT,
  row_id uuid NOT NULL REFERENCES public.data_cutover_rows(id) ON DELETE RESTRICT,
  opening_state_id uuid NOT NULL UNIQUE REFERENCES public.data_cutover_opening_states(id) ON DELETE RESTRICT,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  piece_technique_id uuid NOT NULL REFERENCES public.pieces_techniques(id) ON DELETE RESTRICT,
  historical_version_id uuid NOT NULL REFERENCES public.piece_technique_versions(id) ON DELETE RESTRICT,
  quantity_launched numeric(14,4) NOT NULL CHECK(quantity_launched>0),
  physical_batch_reference text NOT NULL CHECK(length(btrim(physical_batch_reference)) BETWEEN 1 AND 200),
  material_state text NOT NULL CHECK(material_state IN ('NONE_CONSUMED','PARTIAL','ALL_ALREADY_CONSUMED')),
  requirements_hash text NOT NULL CHECK(requirements_hash ~ '^[a-f0-9]{64}$'),
  source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_cutover_wip_material_checkpoint_row_batch_1710_fk FOREIGN KEY(row_id,batch_id)
    REFERENCES public.data_cutover_rows(id,batch_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS data_cutover_wip_material_checkpoint_batch_idx
  ON public.data_cutover_wip_material_checkpoints(batch_id,created_at,id);

CREATE TABLE IF NOT EXISTS public.data_cutover_wip_material_checkpoint_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkpoint_id uuid NOT NULL REFERENCES public.data_cutover_wip_material_checkpoints(id) ON DELETE RESTRICT,
  technical_purchase_id uuid NOT NULL REFERENCES public.pieces_techniques_achats(id) ON DELETE RESTRICT,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  unit text NOT NULL CHECK(length(btrim(unit)) BETWEEN 1 AND 32),
  quantity_consumed numeric(14,4) NOT NULL CHECK(quantity_consumed>=0),
  physical_lot_id uuid NULL REFERENCES public.lots(id) ON DELETE RESTRICT,
  historical_trace_reference text NULL CHECK(historical_trace_reference IS NULL OR length(btrim(historical_trace_reference)) BETWEEN 1 AND 500),
  owner_client_id varchar NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  quality_status text NULL CHECK(quality_status IS NULL OR length(btrim(quality_status)) BETWEEN 1 AND 80),
  quality_evidence_reference text NULL CHECK(quality_evidence_reference IS NULL OR length(btrim(quality_evidence_reference)) BETWEEN 1 AND 500),
  certificate_reference text NULL CHECK(certificate_reference IS NULL OR length(btrim(certificate_reference)) BETWEEN 1 AND 500),
  heat_reference text NULL CHECK(heat_reference IS NULL OR length(btrim(heat_reference)) BETWEEN 1 AND 500),
  material_category text NULL CHECK(material_category IS NULL OR length(btrim(material_category)) BETWEEN 1 AND 120),
  evidence_reference text NOT NULL CHECK(length(btrim(evidence_reference)) BETWEEN 1 AND 500),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_cutover_wip_material_checkpoint_requirement_1710_uq UNIQUE(checkpoint_id,technical_purchase_id),
  CONSTRAINT data_cutover_wip_material_consumed_trace_1710_ck CHECK(
    quantity_consumed=0 OR physical_lot_id IS NOT NULL OR (
      historical_trace_reference IS NOT NULL AND quality_evidence_reference IS NOT NULL AND certificate_reference IS NOT NULL
      AND heat_reference IS NOT NULL AND material_category IS NOT NULL
    )
  )
);
CREATE INDEX IF NOT EXISTS data_cutover_wip_material_checkpoint_lines_article_idx
  ON public.data_cutover_wip_material_checkpoint_lines(article_id,physical_lot_id);

CREATE TABLE IF NOT EXISTS public.data_cutover_wip_material_opening_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkpoint_id uuid NOT NULL REFERENCES public.data_cutover_wip_material_checkpoints(id) ON DELETE RESTRICT,
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  -- A resumed OF is intentionally created BROUILLON. Its normal material
  -- needs are configured afterwards by the existing native workflow, so this
  -- immutable fact binds to the technical requirement rather than pretending
  -- that a need/reservation already existed.
  technical_purchase_id uuid NOT NULL REFERENCES public.pieces_techniques_achats(id) ON DELETE RESTRICT,
  quantity_consumed numeric(14,4) NOT NULL CHECK(quantity_consumed>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_cutover_wip_material_binding_requirement_1710_uq UNIQUE(checkpoint_id,technical_purchase_id)
);
CREATE INDEX IF NOT EXISTS data_cutover_wip_material_opening_bindings_of_idx
  ON public.data_cutover_wip_material_opening_bindings(of_id,technical_purchase_id);

CREATE OR REPLACE FUNCTION public.fn_protect_data_cutover_wip_material_opening_1710()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cutover WIP material opening facts are append-only' USING ERRCODE='23514';
END;
$$;
DROP TRIGGER IF EXISTS data_cutover_wip_material_checkpoint_append_only_1710 ON public.data_cutover_wip_material_checkpoints;
CREATE TRIGGER data_cutover_wip_material_checkpoint_append_only_1710 BEFORE UPDATE OR DELETE
  ON public.data_cutover_wip_material_checkpoints FOR EACH ROW EXECUTE FUNCTION public.fn_protect_data_cutover_wip_material_opening_1710();
DROP TRIGGER IF EXISTS data_cutover_wip_material_line_append_only_1710 ON public.data_cutover_wip_material_checkpoint_lines;
CREATE TRIGGER data_cutover_wip_material_line_append_only_1710 BEFORE UPDATE OR DELETE
  ON public.data_cutover_wip_material_checkpoint_lines FOR EACH ROW EXECUTE FUNCTION public.fn_protect_data_cutover_wip_material_opening_1710();
DROP TRIGGER IF EXISTS data_cutover_wip_material_binding_append_only_1710 ON public.data_cutover_wip_material_opening_bindings;
CREATE TRIGGER data_cutover_wip_material_binding_append_only_1710 BEFORE UPDATE OR DELETE
  ON public.data_cutover_wip_material_opening_bindings FOR EACH ROW EXECUTE FUNCTION public.fn_protect_data_cutover_wip_material_opening_1710();

COMMENT ON TABLE public.data_cutover_wip_material_checkpoints IS
  'Validated cutover material state for one physical WIP cohort. No stock or consumption movement is created.';
COMMENT ON TABLE public.data_cutover_wip_material_opening_bindings IS
  'Read-model bridge from immutable cutover material facts to native OF material needs.';

DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  GRANT SELECT,INSERT ON public.data_cutover_wip_material_checkpoints,data_cutover_wip_material_checkpoint_lines,data_cutover_wip_material_opening_bindings TO cerp_app;
  REVOKE UPDATE,DELETE,TRUNCATE ON public.data_cutover_wip_material_checkpoints,data_cutover_wip_material_checkpoint_lines,data_cutover_wip_material_opening_bindings FROM PUBLIC,cerp_app;
END IF; END $$;
COMMIT;
