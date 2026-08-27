-- #675 - Incoming supplier invoices, matching evidence and approval workflow.
-- Additive, replay-safe through scripts/db-patches.js and deliberately fail-closed.
BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.einvoice_documents') IS NULL
     OR to_regclass('public.einvoice_provider_connections') IS NULL
     OR to_regclass('public.fournisseurs') IS NULL
     OR to_regclass('public.commande_fournisseur') IS NULL
     OR to_regclass('public.commande_fournisseur_ligne') IS NULL
     OR to_regclass('public.reception_fournisseur_lignes') IS NULL
     OR to_regclass('public.procurement_policy_versions') IS NULL
     OR to_regclass('public.ged_documents') IS NULL
     OR to_regclass('public.ged_document_versions') IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER-INVOICES-675 missing prerequisites';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'SUPPLIER-INVOICES-675 runtime role cerp_app is missing';
  END IF;
END
$guard$;

INSERT INTO public.ged_document_classes
  (class_key, domain, label, nature, allowed_mime_types, allowed_extensions,
   max_size_bytes, approvals_required, retention_months, hold_on_publish)
VALUES
  ('FACTURE_FOURNISSEUR', 'ACHATS', 'Facture fournisseur electronique', 'EVIDENCE',
   ARRAY['application/pdf','application/xml','text/xml','image/png','image/jpeg','text/csv',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/vnd.oasis.opendocument.spreadsheet'],
   ARRAY['.pdf','.xml','.png','.jpg','.jpeg','.csv','.xlsx','.ods'],
   26214400, 0, 120, true)
ON CONFLICT (class_key) DO NOTHING;

CREATE TABLE public.supplier_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  einvoice_document_id uuid NOT NULL UNIQUE REFERENCES public.einvoice_documents(id) ON DELETE RESTRICT,
  fournisseur_id uuid NULL REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,
  document_type text NOT NULL CHECK (document_type IN ('INVOICE','CREDIT_NOTE')),
  provider_type_code integer NOT NULL CHECK (provider_type_code > 0),
  legal_number text NOT NULL CHECK (char_length(btrim(legal_number)) BETWEEN 1 AND 200),
  issue_date date NOT NULL,
  payment_due_date date NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  purchase_order_reference text NULL CHECK (purchase_order_reference IS NULL OR char_length(purchase_order_reference) <= 200),
  total_without_vat numeric(18,2) NOT NULL,
  total_vat numeric(18,2) NOT NULL,
  total_with_vat numeric(18,2) NOT NULL,
  amount_due numeric(18,2) NOT NULL,
  vat_breakdown jsonb NOT NULL CHECK (jsonb_typeof(vat_breakdown) = 'array'),
  seller_snapshot jsonb NOT NULL CHECK (jsonb_typeof(seller_snapshot) = 'object'),
  buyer_snapshot jsonb NOT NULL CHECK (jsonb_typeof(buyer_snapshot) = 'object'),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN (
    'RECEIVED','IDENTIFIED','MATCHED','PENDING_APPROVAL','APPROVED',
    'ACCOUNTING_EXPORTED','CLOSED','DISPUTED','REJECTED'
  )),
  identification_error text NULL CHECK (identification_error IS NULL OR char_length(identification_error) <= 500),
  match_summary jsonb NULL CHECK (match_summary IS NULL OR jsonb_typeof(match_summary) = 'object'),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  received_at timestamptz NOT NULL,
  identified_at timestamptz NULL,
  approved_at timestamptz NULL,
  approved_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  accounting_exported_at timestamptz NULL,
  closed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_invoice_approval_675_ck CHECK (
    (approved_at IS NULL AND approved_by IS NULL) OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)
  )
);

CREATE INDEX supplier_invoices_queue_675_idx
  ON public.supplier_invoices(status, payment_due_date NULLS LAST, received_at DESC);
CREATE INDEX supplier_invoices_supplier_675_idx
  ON public.supplier_invoices(fournisseur_id, issue_date DESC) WHERE fournisseur_id IS NOT NULL;
CREATE UNIQUE INDEX supplier_invoices_supplier_legal_675_uq
  ON public.supplier_invoices(fournisseur_id, legal_number, document_type)
  WHERE fournisseur_id IS NOT NULL;

CREATE TABLE public.supplier_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_invoice_id uuid NOT NULL REFERENCES public.supplier_invoices(id) ON DELETE RESTRICT,
  provider_line_id text NOT NULL CHECK (char_length(btrim(provider_line_id)) BETWEEN 1 AND 200),
  position integer NOT NULL CHECK (position > 0),
  designation text NOT NULL CHECK (char_length(btrim(designation)) BETWEEN 1 AND 1000),
  quantity numeric(18,6) NULL,
  unit_code text NULL CHECK (unit_code IS NULL OR char_length(unit_code) <= 20),
  unit_price numeric(18,6) NULL,
  net_amount numeric(18,2) NOT NULL,
  vat_category text NULL CHECK (vat_category IS NULL OR char_length(vat_category) <= 20),
  vat_rate numeric(9,4) NULL CHECK (vat_rate IS NULL OR vat_rate BETWEEN 0 AND 100),
  purchase_order_line_reference text NULL CHECK (
    purchase_order_line_reference IS NULL OR char_length(purchase_order_line_reference) <= 200
  ),
  article_buyer_reference text NULL CHECK (article_buyer_reference IS NULL OR char_length(article_buyer_reference) <= 200),
  article_seller_reference text NULL CHECK (article_seller_reference IS NULL OR char_length(article_seller_reference) <= 200),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_invoice_lines_position_675_uq UNIQUE (supplier_invoice_id, position),
  CONSTRAINT supplier_invoice_lines_provider_675_uq UNIQUE (supplier_invoice_id, provider_line_id),
  CONSTRAINT supplier_invoice_lines_numbers_675_ck CHECK (
    (quantity IS NULL OR quantity <> 0) AND (unit_price IS NULL OR unit_price >= 0)
  )
);
CREATE INDEX supplier_invoice_lines_invoice_675_idx ON public.supplier_invoice_lines(supplier_invoice_id, position);

CREATE TABLE public.supplier_invoice_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_invoice_id uuid NOT NULL REFERENCES public.supplier_invoices(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('ORIGINAL','FACTUR_X','ATTACHMENT')),
  provider_key text NOT NULL DEFAULT '',
  file_name text NOT NULL CHECK (char_length(btrim(file_name)) BETWEEN 1 AND 255),
  mime_type text NOT NULL CHECK (char_length(btrim(mime_type)) BETWEEN 1 AND 120),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
  ged_document_id uuid NULL REFERENCES public.ged_documents(id) ON DELETE RESTRICT,
  ged_version_id uuid NULL REFERENCES public.ged_document_versions(id) ON DELETE RESTRICT,
  scan_status text NOT NULL CHECK (scan_status IN ('PENDING','CLEAN','REJECTED','UNAVAILABLE')),
  scan_provider text NULL CHECK (scan_provider IS NULL OR char_length(scan_provider) <= 80),
  scan_signature_version text NULL CHECK (scan_signature_version IS NULL OR char_length(scan_signature_version) <= 160),
  archived_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_invoice_artifact_ged_675_ck CHECK (
    (ged_document_id IS NULL AND ged_version_id IS NULL AND archived_at IS NULL)
    OR (ged_document_id IS NOT NULL AND ged_version_id IS NOT NULL AND archived_at IS NOT NULL)
  ),
  CONSTRAINT supplier_invoice_artifact_kind_675_uq UNIQUE (supplier_invoice_id, kind, provider_key)
);
CREATE INDEX supplier_invoice_artifact_hash_675_idx
  ON public.supplier_invoice_artifacts(supplier_invoice_id, content_sha256);

CREATE TABLE public.supplier_invoice_match_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_invoice_id uuid NOT NULL REFERENCES public.supplier_invoices(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  mode text NOT NULL CHECK (mode IN ('AUTO','MANUAL')),
  purchase_order_id uuid NULL REFERENCES public.commande_fournisseur(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('MATCHED','VARIANCE','UNMATCHED')),
  policy_snapshot jsonb NOT NULL CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  manual_justification text NULL CHECK (manual_justification IS NULL OR char_length(manual_justification) BETWEEN 3 AND 1000),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_invoice_match_manual_675_ck CHECK (
    (mode = 'MANUAL' AND manual_justification IS NOT NULL)
    OR (mode = 'AUTO' AND manual_justification IS NULL)
  ),
  CONSTRAINT supplier_invoice_match_version_675_uq UNIQUE (supplier_invoice_id, version)
);

CREATE TABLE public.supplier_invoice_line_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_version_id uuid NOT NULL REFERENCES public.supplier_invoice_match_versions(id) ON DELETE RESTRICT,
  supplier_invoice_line_id uuid NOT NULL REFERENCES public.supplier_invoice_lines(id) ON DELETE RESTRICT,
  purchase_order_line_id uuid NULL REFERENCES public.commande_fournisseur_ligne(id) ON DELETE RESTRICT,
  reception_line_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  ordered_quantity numeric(18,6) NULL,
  received_quantity numeric(18,6) NULL,
  invoiced_quantity numeric(18,6) NULL,
  ordered_unit_price numeric(18,6) NULL,
  invoiced_unit_price numeric(18,6) NULL,
  ordered_vat_rate numeric(9,4) NULL,
  invoiced_vat_rate numeric(9,4) NULL,
  price_delta_pct numeric(12,6) NULL,
  price_tolerance_pct numeric(7,4) NULL,
  price_policy_id uuid NULL REFERENCES public.procurement_policy_versions(id) ON DELETE RESTRICT,
  quantity_status text NOT NULL CHECK (quantity_status IN ('EXACT','WITHIN_RECEIPT','OVER_RECEIPT','UNKNOWN','MANUAL')),
  price_status text NOT NULL CHECK (price_status IN ('EXACT','WITHIN_TOLERANCE','OUTSIDE_TOLERANCE','UNQUALIFIED','MANUAL')),
  vat_status text NOT NULL CHECK (vat_status IN ('EXACT','MISMATCH','UNKNOWN','MANUAL')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_invoice_line_match_675_uq UNIQUE (match_version_id, supplier_invoice_line_id)
);

CREATE TABLE public.supplier_invoice_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_invoice_id uuid NOT NULL REFERENCES public.supplier_invoices(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN (
    'RECEIVED','IDENTIFIED','MATCHED','APPROVAL_REQUESTED','APPROVED','DISPUTED','REJECTED','ACCOUNTING_EXPORTED','CLOSED'
  )),
  from_status text NOT NULL,
  to_status text NOT NULL,
  reason text NULL CHECK (reason IS NULL OR char_length(reason) BETWEEN 3 AND 1000),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  actor_user_id integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_invoice_decisions_675_idx
  ON public.supplier_invoice_decisions(supplier_invoice_id, created_at, id);

CREATE TABLE public.super_pdp_sync_cursors (
  provider_code text NOT NULL REFERENCES public.einvoice_provider_connections(provider_code) ON DELETE RESTRICT,
  stream text NOT NULL CHECK (stream IN ('INBOUND_INVOICES','INVOICE_EVENTS')),
  last_provider_id bigint NULL CHECK (last_provider_id IS NULL OR last_provider_id > 0),
  last_attempt_at timestamptz NULL,
  last_success_at timestamptz NULL,
  last_error_code text NULL CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 120),
  last_error_at timestamptz NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  PRIMARY KEY (provider_code, stream)
);

CREATE TABLE public.supplier_invoice_provider_status_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_invoice_id uuid NOT NULL REFERENCES public.supplier_invoices(id) ON DELETE RESTRICT,
  provider_code text NOT NULL REFERENCES public.einvoice_provider_connections(provider_code) ON DELETE RESTRICT,
  provider_document_id text NOT NULL,
  status_code smallint NOT NULL CHECK (status_code IN (205,206,208,211,212)),
  details jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(details) = 'array'),
  correlation_id uuid NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  processing_token uuid NULL,
  processing_started_at timestamptz NULL,
  sent_at timestamptz NULL,
  provider_event_id text NULL,
  last_error_code text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_invoice_outbox_processing_675_ck CHECK (
    (processing_token IS NULL) = (processing_started_at IS NULL)
  )
);
CREATE INDEX supplier_invoice_provider_outbox_675_idx
  ON public.supplier_invoice_provider_status_outbox(next_attempt_at, created_at)
  WHERE sent_at IS NULL;

CREATE TABLE public.supplier_invoice_command_receipts (
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  command_type text NOT NULL CHECK (command_type IN ('IDENTIFY','MATCH','REQUEST_APPROVAL','APPROVE','DISPUTE','REJECT')),
  supplier_invoice_id uuid NOT NULL REFERENCES public.supplier_invoices(id) ON DELETE RESTRICT,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_snapshot jsonb NOT NULL CHECK (jsonb_typeof(response_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, idempotency_key)
);

CREATE FUNCTION public.fn_supplier_invoice_evidence_append_only_675()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $append_only$
BEGIN
  RAISE EXCEPTION '% is append-only; add a new supplier-invoice evidence row instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$append_only$;

CREATE TRIGGER supplier_invoice_lines_append_only_675
  BEFORE UPDATE OR DELETE ON public.supplier_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.fn_supplier_invoice_evidence_append_only_675();
CREATE TRIGGER supplier_invoice_match_versions_append_only_675
  BEFORE UPDATE OR DELETE ON public.supplier_invoice_match_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_supplier_invoice_evidence_append_only_675();
CREATE TRIGGER supplier_invoice_line_matches_append_only_675
  BEFORE UPDATE OR DELETE ON public.supplier_invoice_line_matches
  FOR EACH ROW EXECUTE FUNCTION public.fn_supplier_invoice_evidence_append_only_675();
CREATE TRIGGER supplier_invoice_decisions_append_only_675
  BEFORE UPDATE OR DELETE ON public.supplier_invoice_decisions
  FOR EACH ROW EXECUTE FUNCTION public.fn_supplier_invoice_evidence_append_only_675();
CREATE TRIGGER supplier_invoice_receipts_append_only_675
  BEFORE UPDATE OR DELETE ON public.supplier_invoice_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.fn_supplier_invoice_evidence_append_only_675();

REVOKE ALL ON TABLE public.supplier_invoices FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.supplier_invoice_lines FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.supplier_invoice_artifacts FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.supplier_invoice_match_versions FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.supplier_invoice_line_matches FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.supplier_invoice_decisions FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.super_pdp_sync_cursors FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.supplier_invoice_provider_status_outbox FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.supplier_invoice_command_receipts FROM PUBLIC, cerp_app;

GRANT SELECT, INSERT, UPDATE ON TABLE public.supplier_invoices TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.supplier_invoice_lines TO cerp_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.supplier_invoice_artifacts TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.supplier_invoice_match_versions TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.supplier_invoice_line_matches TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.supplier_invoice_decisions TO cerp_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.super_pdp_sync_cursors TO cerp_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.supplier_invoice_provider_status_outbox TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.supplier_invoice_command_receipts TO cerp_app;
GRANT SELECT ON TABLE public.ged_document_classes TO cerp_app;

REVOKE ALL ON FUNCTION public.fn_supplier_invoice_evidence_append_only_675() FROM PUBLIC, cerp_app;
GRANT EXECUTE ON FUNCTION public.fn_supplier_invoice_evidence_append_only_675() TO cerp_app;

COMMENT ON TABLE public.supplier_invoices IS
  '#675 inbound supplier invoice workflow. Source fiscal values are immutable snapshots; only workflow state/version changes.';
COMMENT ON TABLE public.supplier_invoice_match_versions IS
  '#675 append-only 3-way match evidence. A null tolerance remains unqualified and is never interpreted as zero.';
COMMENT ON TABLE public.super_pdp_sync_cursors IS
  '#675 durable incremental SUPERPDP cursors; advanced only after dossier and artifacts are durable.';

COMMIT;
