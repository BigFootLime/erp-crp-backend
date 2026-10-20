-- Preparation only: no business rows, issued documents, stock or counters are changed.
CREATE TABLE IF NOT EXISTS public.data_cutover_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  source_system varchar(40) NOT NULL CHECK (source_system = 'CLIPPER_EXCEL'),
  source_hash char(64) NOT NULL UNIQUE,
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array'),
  status varchar(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'VALIDATED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  cutoff_at timestamptz,
  preview_hash char(64),
  preview_payload jsonb,
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by integer NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.data_cutover_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.data_cutover_batches(id) ON DELETE RESTRICT,
  domain varchar(40) NOT NULL CHECK (domain IN ('CUSTOMER','SUPPLIER','ARTICLE','TECHNICAL_PIECE','SALES_ORDER','INTERNAL_DEMAND','SUPPLIER_ORDER','OPENING_STOCK','WIP','LEGACY_DELIVERY','LEGACY_RECEIPT','OPENING_RECEIVABLE','OPENING_PAYABLE','LEGACY_PROFORMA','METROLOGY')),
  legacy_key varchar(300) NOT NULL,
  source_id varchar(120) NOT NULL,
  sheet varchar(100) NOT NULL,
  row_number integer NOT NULL CHECK (row_number > 0),
  source_values jsonb NOT NULL CHECK (jsonb_typeof(source_values) = 'object'),
  "values" jsonb NOT NULL CHECK (jsonb_typeof("values") = 'object'),
  source_issues jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_issues) = 'array'),
  source_notes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_notes) = 'array'),
  decision varchar(10) NOT NULL DEFAULT 'PENDING' CHECK (decision IN ('PENDING','INCLUDE','EXCLUDE')),
  review_note text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by integer NOT NULL REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, domain, legacy_key)
);
CREATE INDEX IF NOT EXISTS data_cutover_rows_batch_domain_idx ON public.data_cutover_rows(batch_id, domain, row_number, id);
CREATE UNIQUE INDEX IF NOT EXISTS data_cutover_rows_id_batch_1710_uq ON public.data_cutover_rows(id,batch_id);
CREATE INDEX IF NOT EXISTS data_cutover_batches_created_idx ON public.data_cutover_batches(created_at DESC, id);

CREATE TABLE IF NOT EXISTS public.data_cutover_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id integer NOT NULL REFERENCES public.users(id),
  operation varchar(80) NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  request_hash char(64) NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.data_cutover_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.data_cutover_batches(id),
  row_id uuid REFERENCES public.data_cutover_rows(id),
  actor_user_id integer NOT NULL REFERENCES public.users(id),
  action varchar(80) NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS data_cutover_commands_actor_time_idx ON public.data_cutover_commands(actor_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS data_cutover_events_batch_idx ON public.data_cutover_events(batch_id, created_at, id);
ALTER TABLE public.data_cutover_events DROP CONSTRAINT IF EXISTS data_cutover_event_row_batch_1710_fk;
ALTER TABLE public.data_cutover_events ADD CONSTRAINT data_cutover_event_row_batch_1710_fk
  FOREIGN KEY(row_id,batch_id) REFERENCES public.data_cutover_rows(id,batch_id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS public.data_cutover_contributors (
  batch_id uuid NOT NULL REFERENCES public.data_cutover_batches(id),
  user_id integer NOT NULL REFERENCES public.users(id),
  domain varchar(40) NOT NULL CHECK (domain IN ('ARTICLE','TECHNICAL_PIECE','SALES_ORDER','SUPPLIER_ORDER','INTERNAL_DEMAND','OPENING_STOCK','WIP','METROLOGY')),
  assigned_by integer NOT NULL REFERENCES public.users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, user_id, domain)
);
ALTER TABLE public.data_cutover_contributors DROP CONSTRAINT IF EXISTS data_cutover_contributors_domain_check;
ALTER TABLE public.data_cutover_contributors ADD CONSTRAINT data_cutover_contributors_domain_check
  CHECK (domain IN ('ARTICLE','TECHNICAL_PIECE','SALES_ORDER','SUPPLIER_ORDER','INTERNAL_DEMAND','OPENING_STOCK','WIP','METROLOGY'));
CREATE INDEX IF NOT EXISTS data_cutover_contributors_user_idx ON public.data_cutover_contributors(user_id,batch_id);

-- Freeze the captured source identity and original values; amendments are separate.
CREATE OR REPLACE FUNCTION public.fn_protect_data_cutover_source_1710()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.batch_id, NEW.domain, NEW.legacy_key, NEW.source_id, NEW.sheet, NEW.row_number, NEW.source_values, NEW.source_issues, NEW.source_notes)
    IS DISTINCT FROM ROW(OLD.batch_id, OLD.domain, OLD.legacy_key, OLD.source_id, OLD.sheet, OLD.row_number, OLD.source_values, OLD.source_issues, OLD.source_notes) THEN
    RAISE EXCEPTION 'Cutover source evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS data_cutover_source_immutable_1710 ON public.data_cutover_rows;
CREATE TRIGGER data_cutover_source_immutable_1710 BEFORE UPDATE ON public.data_cutover_rows
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_data_cutover_source_1710();

COMMENT ON TABLE public.data_cutover_batches IS 'Private preparation workspace. VALIDATED means preparation signed off, never business data posted.';
COMMENT ON TABLE public.data_cutover_events IS 'Append-only audit without source payloads or secret data.';

CREATE OR REPLACE FUNCTION public.fn_protect_data_cutover_batch_source_1710()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.source_system,NEW.source_hash,NEW.sources,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.source_system,OLD.source_hash,OLD.sources,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'Cutover source manifest is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS data_cutover_batch_source_immutable_1710 ON public.data_cutover_batches;
CREATE TRIGGER data_cutover_batch_source_immutable_1710 BEFORE UPDATE ON public.data_cutover_batches
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_data_cutover_batch_source_1710();
CREATE OR REPLACE FUNCTION public.fn_protect_data_cutover_audit_1710()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Cutover command receipts and audit are append-only' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS data_cutover_events_immutable_1710 ON public.data_cutover_events;
CREATE TRIGGER data_cutover_events_immutable_1710 BEFORE UPDATE OR DELETE ON public.data_cutover_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_data_cutover_audit_1710();
DROP TRIGGER IF EXISTS data_cutover_commands_immutable_1710 ON public.data_cutover_commands;
CREATE TRIGGER data_cutover_commands_immutable_1710 BEFORE UPDATE OR DELETE ON public.data_cutover_commands
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_data_cutover_audit_1710();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  GRANT SELECT,INSERT,UPDATE ON public.data_cutover_batches,public.data_cutover_rows,public.data_cutover_contributors TO cerp_app;
  GRANT DELETE ON public.data_cutover_contributors TO cerp_app;
  GRANT SELECT,INSERT ON public.data_cutover_commands,public.data_cutover_events TO cerp_app;
  REVOKE DELETE,TRUNCATE ON public.data_cutover_batches,public.data_cutover_rows FROM PUBLIC,cerp_app;
  REVOKE UPDATE,DELETE,TRUNCATE ON public.data_cutover_commands,public.data_cutover_events FROM PUBLIC,cerp_app;
END IF; END $$;
