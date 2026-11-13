BEGIN;

DO $$
BEGIN
  IF current_database() ~ '^cerp_directory_' THEN
    RAISE EXCEPTION 'Intercompany fulfilment receipts belong to a business database';
  END IF;
  IF to_regclass('public.commande_client') IS NULL OR to_regclass('public.commande_ligne') IS NULL THEN
    RAISE EXCEPTION 'Customer-order prerequisites are required';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.cerp_intercompany_external_fulfilment_receipts (
  message_id uuid PRIMARY KEY REFERENCES public.cerp_intercompany_inbox(id) ON DELETE RESTRICT,
  receipt_id uuid NOT NULL,
  source_company_id uuid NOT NULL,
  destination_company_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('cerp_prod', 'cerp_test')),
  relation_id uuid NOT NULL,
  buyer_sales_order_id bigint NOT NULL REFERENCES public.commande_client(id) ON DELETE RESTRICT,
  buyer_purchase_order_id uuid NOT NULL REFERENCES public.commande_fournisseur(id) ON DELETE RESTRICT,
  seller_delivery_id text NOT NULL CHECK (length(btrim(seller_delivery_id)) > 0),
  seller_delivery_number text NOT NULL CHECK (length(btrim(seller_delivery_number)) > 0),
  dispatched_at timestamptz NOT NULL,
  document_id text NOT NULL CHECK (length(btrim(document_id)) > 0),
  document_kind text NOT NULL CHECK (document_kind = 'AUTHORITATIVE_SNAPSHOT'),
  -- Digest of the durable authoritative source snapshot, deliberately not a
  -- PDF-byte digest: PDF rendering/archival is an asynchronous second step.
  document_snapshot_sha256 text NOT NULL CHECK (document_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  raw_payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_company_id, receipt_id)
);

CREATE TABLE IF NOT EXISTS public.cerp_intercompany_external_fulfilment_receipt_lines (
  message_id uuid NOT NULL REFERENCES public.cerp_intercompany_external_fulfilment_receipts(message_id) ON DELETE CASCADE,
  line_no integer NOT NULL CHECK (line_no > 0),
  buyer_sales_order_line_id bigint NOT NULL REFERENCES public.commande_ligne(id) ON DELETE RESTRICT,
  buyer_purchase_order_line_id uuid NOT NULL REFERENCES public.commande_fournisseur_ligne(id) ON DELETE RESTRICT,
  seller_delivery_line_id text NOT NULL CHECK (length(btrim(seller_delivery_line_id)) > 0),
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL CHECK (length(btrim(unit)) > 0),
  PRIMARY KEY (message_id, line_no),
  UNIQUE (message_id, buyer_sales_order_line_id, seller_delivery_line_id)
);

CREATE INDEX IF NOT EXISTS cerp_intercompany_external_fulfilment_receipts_order_idx
  ON public.cerp_intercompany_external_fulfilment_receipts (buyer_sales_order_id, dispatched_at DESC);
CREATE INDEX IF NOT EXISTS cerp_intercompany_external_fulfilment_receipt_lines_order_line_idx
  ON public.cerp_intercompany_external_fulfilment_receipt_lines (buyer_sales_order_line_id);

REVOKE ALL ON public.cerp_intercompany_external_fulfilment_receipts,
              public.cerp_intercompany_external_fulfilment_receipt_lines FROM PUBLIC;
GRANT SELECT, INSERT ON public.cerp_intercompany_external_fulfilment_receipts,
                        public.cerp_intercompany_external_fulfilment_receipt_lines TO cerp_app;

COMMIT;
