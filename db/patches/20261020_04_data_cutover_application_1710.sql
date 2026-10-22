-- Dedicated production-capable cutover command. No native business data is
-- inserted by this migration. A receipt and every native write share one TX.
BEGIN;
CREATE TABLE IF NOT EXISTS public.data_cutover_application_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.data_cutover_batches(id) ON DELETE RESTRICT,
  batch_version integer NOT NULL CHECK(batch_version>0),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  preview_hash text NOT NULL CHECK(preview_hash ~ '^[a-f0-9]{64}$'),
  checkpoint jsonb NOT NULL CHECK(jsonb_typeof(checkpoint)='object'),
  receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_user_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS data_cutover_application_runs_batch_idx
  ON public.data_cutover_application_runs(batch_id,created_at DESC);
CREATE TABLE IF NOT EXISTS public.data_cutover_application_crosswalk (
  source_system text NOT NULL,
  domain text NOT NULL,
  legacy_key text NOT NULL,
  source_reference text NOT NULL,
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  values_snapshot jsonb NOT NULL CHECK(jsonb_typeof(values_snapshot)='object'),
  source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
  target_type text NOT NULL,
  target_id text NOT NULL,
  target_reference text,
  batch_id uuid NOT NULL REFERENCES public.data_cutover_batches(id) ON DELETE RESTRICT,
  row_id uuid NOT NULL REFERENCES public.data_cutover_rows(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES public.data_cutover_application_runs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_system,domain,legacy_key)
);
CREATE INDEX IF NOT EXISTS data_cutover_application_crosswalk_source_reference_idx
  ON public.data_cutover_application_crosswalk(source_system,domain,source_reference);
ALTER TABLE public.data_cutover_application_crosswalk DROP CONSTRAINT IF EXISTS data_cutover_crosswalk_row_batch_1710_fk;
ALTER TABLE public.data_cutover_application_crosswalk ADD CONSTRAINT data_cutover_crosswalk_row_batch_1710_fk
  FOREIGN KEY(row_id,batch_id) REFERENCES public.data_cutover_rows(id,batch_id) ON DELETE RESTRICT;
CREATE TABLE IF NOT EXISTS public.data_cutover_application_operations (
  run_id uuid NOT NULL REFERENCES public.data_cutover_application_runs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  operation_key text NOT NULL,
  kind text NOT NULL,
  source_row_ids uuid[] NOT NULL,
  targets jsonb NOT NULL CHECK(jsonb_typeof(targets)='array'),
  PRIMARY KEY(run_id,operation_key)
);
CREATE TABLE IF NOT EXISTS public.data_cutover_application_order_groups (
  source_system text NOT NULL,
  domain text NOT NULL CHECK(domain IN ('SALES_ORDER','SUPPLIER_ORDER','INTERNAL_DEMAND')),
  group_key text NOT NULL,
  run_id uuid NOT NULL REFERENCES public.data_cutover_application_runs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  targets jsonb NOT NULL CHECK(jsonb_typeof(targets)='array'),
  PRIMARY KEY(source_system,domain,group_key)
);
CREATE OR REPLACE FUNCTION public.data_cutover_application_immutable_1710()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Cutover receipts and correspondences are immutable' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS data_cutover_application_runs_immutable ON public.data_cutover_application_runs;
CREATE TRIGGER data_cutover_application_runs_immutable BEFORE UPDATE OR DELETE
  ON public.data_cutover_application_runs FOR EACH ROW EXECUTE FUNCTION public.data_cutover_application_immutable_1710();
DROP TRIGGER IF EXISTS data_cutover_application_crosswalk_immutable ON public.data_cutover_application_crosswalk;
CREATE TRIGGER data_cutover_application_crosswalk_immutable BEFORE UPDATE OR DELETE
  ON public.data_cutover_application_crosswalk FOR EACH ROW EXECUTE FUNCTION public.data_cutover_application_immutable_1710();
DROP TRIGGER IF EXISTS data_cutover_application_operations_immutable ON public.data_cutover_application_operations;
CREATE TRIGGER data_cutover_application_operations_immutable BEFORE UPDATE OR DELETE
  ON public.data_cutover_application_operations FOR EACH ROW EXECUTE FUNCTION public.data_cutover_application_immutable_1710();
DROP TRIGGER IF EXISTS data_cutover_application_order_groups_immutable ON public.data_cutover_application_order_groups;
CREATE TRIGGER data_cutover_application_order_groups_immutable BEFORE UPDATE OR DELETE
  ON public.data_cutover_application_order_groups FOR EACH ROW EXECUTE FUNCTION public.data_cutover_application_immutable_1710();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  GRANT SELECT,INSERT ON public.data_cutover_application_runs,public.data_cutover_application_crosswalk,public.data_cutover_application_operations,public.data_cutover_application_order_groups TO cerp_app;
  REVOKE UPDATE,DELETE,TRUNCATE ON public.data_cutover_application_runs,public.data_cutover_application_crosswalk,public.data_cutover_application_operations,public.data_cutover_application_order_groups FROM PUBLIC,cerp_app;
END IF; END $$;
COMMIT;
