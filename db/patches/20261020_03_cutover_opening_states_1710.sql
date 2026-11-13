-- #1710: explicit opening states for data cutover.
-- These records preserve an acknowledged opening position. They are not OFs,
-- invoices, receipts, deliveries or stock movements and never impersonate one.
BEGIN;

CREATE TABLE IF NOT EXISTS public.data_cutover_opening_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.data_cutover_batches(id) ON DELETE RESTRICT,
  row_id uuid NOT NULL REFERENCES public.data_cutover_rows(id) ON DELETE RESTRICT,
  opening_kind text NOT NULL CHECK (opening_kind IN ('WIP','FINANCE_BALANCE','UNBILLED_LEGACY_DOCUMENT')),
  domain text NOT NULL CHECK (domain IN ('WIP','OPENING_RECEIVABLE','OPENING_PAYABLE','LEGACY_DELIVERY','LEGACY_RECEIPT')),
  source_system text NOT NULL CHECK (source_system='CLIPPER_EXCEL'),
  state jsonb NOT NULL CHECK (jsonb_typeof(state)='object'),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance)='object'),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_cutover_opening_row_kind_1710_uq UNIQUE(row_id,opening_kind),
  CONSTRAINT data_cutover_opening_kind_domain_1710_ck CHECK (
    (opening_kind='WIP' AND domain='WIP')
    OR (opening_kind='FINANCE_BALANCE' AND domain IN ('OPENING_RECEIVABLE','OPENING_PAYABLE'))
    OR (opening_kind='UNBILLED_LEGACY_DOCUMENT' AND domain IN ('LEGACY_DELIVERY','LEGACY_RECEIPT'))
  )
);
CREATE INDEX IF NOT EXISTS data_cutover_opening_states_batch_idx
  ON public.data_cutover_opening_states(batch_id,opening_kind,created_at,id);
ALTER TABLE public.data_cutover_opening_states DROP CONSTRAINT IF EXISTS data_cutover_opening_row_batch_1710_fk;
ALTER TABLE public.data_cutover_opening_states ADD CONSTRAINT data_cutover_opening_row_batch_1710_fk
  FOREIGN KEY(row_id,batch_id) REFERENCES public.data_cutover_rows(id,batch_id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS public.data_cutover_opening_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opening_state_id uuid NOT NULL REFERENCES public.data_cutover_opening_states(id) ON DELETE RESTRICT,
  link_kind text NOT NULL CHECK (link_kind IN ('NATIVE_TARGET','REVIEW_RESOLUTION')),
  native_target_type text NOT NULL CHECK (length(btrim(native_target_type)) BETWEEN 1 AND 80),
  native_target_id text NOT NULL CHECK (length(btrim(native_target_id)) BETWEEN 1 AND 160),
  native_target_reference text NOT NULL CHECK (length(btrim(native_target_reference)) BETWEEN 1 AND 300),
  evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) BETWEEN 1 AND 500),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_cutover_opening_link_1710_uq UNIQUE(opening_state_id,link_kind,native_target_type,native_target_id)
);
CREATE INDEX IF NOT EXISTS data_cutover_opening_links_state_idx
  ON public.data_cutover_opening_links(opening_state_id,created_at,id);

DO $$
BEGIN
  -- The opening-state subsystem is independently testable on a minimal
  -- cutover database.  The stock extension is applied only where the native
  -- stock trace table is already present.
  IF to_regclass('public.stock_lot_trace_references') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.stock_lot_trace_references') AND conname='stock_lot_trace_references_type_446_ck') THEN
    ALTER TABLE public.stock_lot_trace_references DROP CONSTRAINT stock_lot_trace_references_type_446_ck;
    ALTER TABLE public.stock_lot_trace_references ADD CONSTRAINT stock_lot_trace_references_type_446_ck
      CHECK (reference_type IN ('OF','AFFAIRE','MP_LOT','TRAITEMENT_LOT','HISTORICAL_LOT'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_protect_data_cutover_opening_state_1710()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cutover opening states are append-only' USING ERRCODE='23514';
END;
$$;
DROP TRIGGER IF EXISTS data_cutover_opening_state_append_only_1710 ON public.data_cutover_opening_states;
CREATE TRIGGER data_cutover_opening_state_append_only_1710 BEFORE UPDATE OR DELETE ON public.data_cutover_opening_states
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_data_cutover_opening_state_1710();
DROP TRIGGER IF EXISTS data_cutover_opening_link_append_only_1710 ON public.data_cutover_opening_links;
CREATE TRIGGER data_cutover_opening_link_append_only_1710 BEFORE UPDATE OR DELETE ON public.data_cutover_opening_links
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_data_cutover_opening_state_1710();

COMMENT ON TABLE public.data_cutover_opening_states IS 'Append-only opening facts from cutover. OPENING_REVIEW_REQUIRED until a separate native target or review resolution is linked.';
COMMENT ON TABLE public.data_cutover_opening_links IS 'Append-only links from cutover opening facts to later reviewed native targets; no native document is created by the opening state itself.';
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  GRANT SELECT,INSERT ON public.data_cutover_opening_states,public.data_cutover_opening_links TO cerp_app;
  REVOKE UPDATE,DELETE,TRUNCATE ON public.data_cutover_opening_states,public.data_cutover_opening_links FROM PUBLIC,cerp_app;
END IF; END $$;
COMMIT;
